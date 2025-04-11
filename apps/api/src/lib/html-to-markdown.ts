import koffi from "koffi";
import { join } from "path";
import "../services/sentry";
import * as Sentry from "@sentry/node";

import dotenv from "dotenv";
import { logger } from "./logger";
import { stat } from "fs/promises";
dotenv.config();

// TODO: add a timeout to the Go parser
const goExecutablePath = join(
  process.cwd(),
  "sharedLibs",
  "go-html-to-md",
  "html-to-markdown.so",
);

class GoMarkdownConverter {
  private static instance: GoMarkdownConverter;
  private convert: any;

  private constructor() {
    const lib = koffi.load(goExecutablePath);
    this.convert = lib.func("ConvertHTMLToMarkdown", "string", ["string"]);
  }

  public static async getInstance(): Promise<GoMarkdownConverter> {
    if (!GoMarkdownConverter.instance) {
      try {
        await stat(goExecutablePath);
      } catch (_) {
        throw Error("Go shared library not found");
      }
      GoMarkdownConverter.instance = new GoMarkdownConverter();
    }
    return GoMarkdownConverter.instance;
  }

  public async convertHTMLToMarkdown(html: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.convert.async(html, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }
}

export async function parseMarkdown(
  html: string | null | undefined,
): Promise<string> {
  if (!html) {
    return "";
  }

  try {
    if (process.env.USE_GO_MARKDOWN_PARSER == "true") {
      const converter = await GoMarkdownConverter.getInstance();
      let markdownContent = await converter.convertHTMLToMarkdown(html);

      markdownContent = processMultiLineLinks(markdownContent);
      markdownContent = removeSkipToContentLinks(markdownContent);
      // logger.info(`HTML to Markdown conversion using Go parser successful`);
      return markdownContent;
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Go shared library not found"
    ) {
      Sentry.captureException(error);
      logger.error(
        `Error converting HTML to Markdown with Go parser: ${error}`,
      );
    } else {
      logger.warn(
        "Tried to use Go parser, but it doesn't exist in the file system.",
        { goExecutablePath },
      );
    }
  }

  // Fallback to TurndownService if Go parser fails or is not enabled
  var TurndownService = require("turndown");
  var turndownPluginGfm = require("joplin-turndown-plugin-gfm");

  const turndownService = new TurndownService();
  
  // 添加处理微信文章图片的规则
  turndownService.addRule("wechatImages", {
    filter: function(node) {
      // 检查是否是图片节点
      if (node.nodeName !== "IMG") return false;
      
      // 条件1：有data-src属性
      const hasDataSrc = node.getAttribute("data-src") !== null;
      
      // 条件2：有特定的类名
      const className = node.className || "";
      const hasWechatClass = typeof className === 'string' && 
        (className.includes("rich_pages") || className.includes("wxw-img"));
      
      // 条件3：src包含微信特定参数
      const src = node.getAttribute("src") || "";
      const hasWechatSrc = src.includes("wx_fmt=") || src.includes("mmbiz.qpic.cn");
      
      // 任一条件匹配即为微信图片
      return hasDataSrc || hasWechatClass || hasWechatSrc;
    },
    replacement: function(content, node) {
      // 优先使用data-src属性，其次使用src
      let src = node.getAttribute("data-src") || node.getAttribute("src") || "";
      
      // 如果src是SVG占位符并且没有data-src，尝试从原始HTML中提取更多信息
      if (src.includes("data:image/svg") && !node.getAttribute("data-src")) {
        // 查找最接近的可能属性
        const possibleAttrs = ["data-backsrc", "data-fail-src", "data-original", "data-backupSrc"];
        for (const attr of possibleAttrs) {
          const attrValue = node.getAttribute(attr);
          if (attrValue && attrValue.startsWith("http")) {
            src = attrValue;
            break;
          }
        }
      }
      
      // 移除微信特定的懒加载参数
      src = src.replace(/&wx_lazy=\d+/, "").replace(/&wx_co=\d+/, "");
      
      const alt = node.getAttribute("alt") || "图片";
      const title = node.getAttribute("title") || "";
      
      return title 
        ? `![${alt}](${src} "${title}")`
        : `![${alt}](${src})`;
    }
  });
  
  turndownService.addRule("inlineLink", {
    filter: function (node, options) {
      return (
        options.linkStyle === "inlined" &&
        node.nodeName === "A" &&
        node.getAttribute("href")
      );
    },
    replacement: function (content, node) {
      var href = node.getAttribute("href").trim();
      var title = node.title ? ' "' + node.title + '"' : "";
      return "[" + content.trim() + "](" + href + title + ")\n";
    },
  });
  var gfm = turndownPluginGfm.gfm;
  turndownService.use(gfm);

  try {
    let markdownContent = await turndownService.turndown(html);
    markdownContent = processMultiLineLinks(markdownContent);
    markdownContent = removeSkipToContentLinks(markdownContent);

    return markdownContent;
  } catch (error) {
    logger.error("Error converting HTML to Markdown", { error });
    return ""; // Optionally return an empty string or handle the error as needed
  }
}

function processMultiLineLinks(markdownContent: string): string {
  let insideLinkContent = false;
  let newMarkdownContent = "";
  let linkOpenCount = 0;
  for (let i = 0; i < markdownContent.length; i++) {
    const char = markdownContent[i];

    if (char == "[") {
      linkOpenCount++;
    } else if (char == "]") {
      linkOpenCount = Math.max(0, linkOpenCount - 1);
    }
    insideLinkContent = linkOpenCount > 0;

    if (insideLinkContent && char == "\n") {
      newMarkdownContent += "\\" + "\n";
    } else {
      newMarkdownContent += char;
    }
  }
  return newMarkdownContent;
}

function removeSkipToContentLinks(markdownContent: string): string {
  // Remove [Skip to Content](#page) and [Skip to content](#skip)
  const newMarkdownContent = markdownContent.replace(
    /\[Skip to Content\]\(#[^\)]*\)/gi,
    "",
  );
  return newMarkdownContent;
}
