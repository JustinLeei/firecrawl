import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { chromium, Browser, BrowserContext, Route, Request as PlaywrightRequest, Page } from 'playwright';
import dotenv from 'dotenv';
import UserAgent from 'user-agents';
import { getError } from './helpers/get_error';

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(bodyParser.json());

const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE';

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com'
];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
}

let browser: Browser;
let context: BrowserContext;

const initializeBrowser = async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  });

  const userAgent = new UserAgent().toString();
  const viewport = { width: 1280, height: 800 };

  const contextOptions: any = {
    userAgent,
    viewport,
  };

  if (PROXY_SERVER && PROXY_USERNAME && PROXY_PASSWORD) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    };
  } else if (PROXY_SERVER) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
    };
  }

  context = await browser.newContext(contextOptions);

  if (BLOCK_MEDIA) {
    await context.route('**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}', async (route: Route, request: PlaywrightRequest) => {
      await route.abort();
    });
  }

  // Intercept all requests to avoid loading ads
  await context.route('**/*', (route: Route, request: PlaywrightRequest) => {
    const requestUrl = new URL(request.url());
    const hostname = requestUrl.hostname;

    if (AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
      console.log(hostname);
      return route.abort();
    }
    return route.continue();
  });
};

const shutdownBrowser = async () => {
  if (context) {
    await context.close();
  }
  if (browser) {
    await browser.close();
  }
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const scrapePage = async (page: Page, url: string, waitUntil: 'load' | 'networkidle', waitAfterLoad: number, timeout: number, checkSelector: string | undefined) => {
  console.log(`Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`);
  const response = await page.goto(url, { waitUntil, timeout });
  console.log('页面初始加载完成');

  // 等待更长时间确保初始渲染完成
  await page.waitForTimeout(1000);

  // 添加自动滚动逻辑触发懒加载
  await autoScrollPage(page);
  
  // 专门处理微信文章中的懒加载图片
  await handleWechatLazyImages(page);
  
  // 尝试点击页面以触发可能的事件
  try {
    await page.click('body');
    console.log('点击页面触发事件');
  } catch (error) {
    console.error('点击页面出错:', error);
  }
  
  // 额外尝试处理页面上的特定微信图片格式
  try {
    // 对微信公众号文章中的图片进行特殊处理
    await page.evaluate(() => {
      // 微信特定的图片选择器
      const wxImageSelectors = [
        'img.rich_pages', 
        'img.wxw-img', 
        'img[data-src]',
        'img[src*="wx_fmt="]'
      ];
      
      // 合并所有选择器并处理找到的图片
      const wxImages = document.querySelectorAll(wxImageSelectors.join(','));
      console.log('发现微信特定格式图片:', wxImages.length);
      
      // 处理每一张微信图片
      wxImages.forEach(img => {
        // 优先使用data-src，否则保留原src
        const dataSrc = img.getAttribute('data-src');
        if (dataSrc) {
          // 移除懒加载参数
          let cleanSrc = dataSrc.replace(/&wx_lazy=\d+/, '').replace(/&wx_co=\d+/, '');
          img.setAttribute('src', cleanSrc);
        }
      });
      
      return wxImages.length;
    });
    console.log('完成微信特定图片处理');
  } catch (error) {
    console.error('处理微信特定图片格式出错:', error);
  }

  if (waitAfterLoad > 0) {
    console.log(`等待额外时间: ${waitAfterLoad}ms`);
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
      console.log(`找到指定选择器: ${checkSelector}`);
    } catch (error) {
      throw new Error('Required selector not found');
    }
  }

  // 记录图片处理状态
  try {
    const imgStatus = await page.evaluate(() => {
      const allImages = document.querySelectorAll('img');
      let stats = {
        total: allImages.length,
        withDataSrc: 0,
        withSvgPlaceholder: 0,
        withRealImage: 0
      };
      
      allImages.forEach(img => {
        if (img.getAttribute('data-src')) stats.withDataSrc++;
        if (img.src.includes('data:image/svg')) stats.withSvgPlaceholder++;
        if (!img.src.includes('data:image/svg') && img.src.includes('http')) stats.withRealImage++;
      });
      
      return stats;
    });
    console.log('页面图片状态:', imgStatus);
  } catch (error) {
    console.error('获取图片状态出错:', error);
  }

  console.log('获取页面内容...');
  let headers = null, content = await page.content();
  if (response) {
    headers = await response.allHeaders();
    const ct = Object.entries(headers).find(x => x[0].toLowerCase() === "content-type");
    if (ct && (ct[1].includes("application/json") || ct[1].includes("text/plain"))) {
      content = (await response.body()).toString("utf8"); // TODO: determine real encoding
    }
  }

  return {
    content,
    status: response ? response.status() : null,
    headers,
  };
};

// 添加自动滚动函数 - 不使用TypeScript中的async/await
const autoScrollPage = async (page: Page) => {
  try {
    // 使用纯JavaScript的Promise方式实现自动滚动
    await page.evaluate(() => {
      return new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 100;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve(true);
          }
        }, 100);
      });
    });
    console.log('自动滚动完成');
  } catch (error) {
    console.error('自动滚动出错:', error);
  }
};

// 处理微信文章中的懒加载图片 - 避免使用async/await
const handleWechatLazyImages = async (page: Page) => {
  try {
    // 处理微信图片懒加载 - 方法一：直接设置src属性
    await page.evaluate(() => {
      const lazyImages = document.querySelectorAll('img[data-src]');
      console.log('找到懒加载图片数量:', lazyImages.length);
      
      // 处理所有带data-src的图片
      for (let i = 0; i < lazyImages.length; i++) {
        const img = lazyImages[i];
        const dataSrc = img.getAttribute('data-src');
        if (dataSrc) {
          img.setAttribute('src', dataSrc);
          console.log('设置图片src:', dataSrc);
        }
      }
      
      // 返回处理好的图片数量
      return lazyImages.length;
    });
    
    // 等待一段时间让图片加载 
    await page.waitForTimeout(2000);
    
    // 尝试方法二：模拟滚动触发懒加载
    await page.evaluate(() => {
      // 查找所有带wx_lazy标记的图片和SVG占位符图片
      const placeholderImages = document.querySelectorAll('img[src*="wx_lazy=1"], img[src*="data:image/svg+xml"]');
      console.log('找到占位图片:', placeholderImages.length);
      
      // 尝试触发懒加载
      placeholderImages.forEach(img => {
        // 创建并分发滚动事件到图片上
        const scrollEvent = new Event('scroll');
        img.dispatchEvent(scrollEvent);
        
        // 如果有data-src属性，则直接替换
        if (img.getAttribute('data-src')) {
          img.setAttribute('src', img.getAttribute('data-src') || '');
        }
      });
      
      return placeholderImages.length;
    });
    
    // 再等待图片加载完成
    await page.waitForTimeout(2000);
    
    console.log('图片懒加载处理完成');
  } catch (error) {
    console.error('处理懒加载图片出错:', error);
  }
};

app.post('/scrape', async (req: Request, res: Response) => {
  // 增加默认等待时间，确保图片有足够时间加载
  const { url, wait_after_load = 2000, timeout = 30000, headers, check_selector }: UrlModel = req.body;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : 'None'}`);
  console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`);
  console.log(`==================================================`);

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!PROXY_SERVER) {
    console.warn('⚠️ WARNING: No proxy server provided. Your IP address may be blocked.');
  }

  if (!browser || !context) {
    await initializeBrowser();
  }

  const page = await context.newPage();

  // Set headers if provided
  if (headers) {
    await page.setExtraHTTPHeaders(headers);
  }

  let result: Awaited<ReturnType<typeof scrapePage>>;
  try {
    // 始终使用 networkidle 策略
    console.log('Using networkidle strategy with scrolling for lazy-loaded images');
    result = await scrapePage(page, url, 'networkidle', wait_after_load, timeout, check_selector);
  } catch (error) {
    console.log('Strategy failed:', error);
    await page.close();
    return res.status(500).json({ error: 'An error occurred while fetching the page.' });
  }

  const pageError = result.status !== 200 ? getError(result.status) : undefined;

  if (!pageError) {
    console.log(`✅ Scrape successful!`);
  } else {
    console.log(`🚨 Scrape failed with status code: ${result.status} ${pageError}`);
  }

  await page.close();

  res.json({
    content: result.content,
    pageStatusCode: result.status,
    ...(pageError && { pageError })
  });
});

app.listen(port, () => {
  initializeBrowser().then(() => {
    console.log(`Server is running on port ${port}`);
  });
});

process.on('SIGINT', () => {
  shutdownBrowser().then(() => {
    console.log('Browser closed');
    process.exit(0);
  });
});
