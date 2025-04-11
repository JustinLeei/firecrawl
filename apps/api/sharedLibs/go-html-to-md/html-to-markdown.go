package main

import (
	"C"
	// "log"
	"regexp"
	"strings"

	md "github.com/tomkosm/html-to-markdown"
	"github.com/tomkosm/html-to-markdown/plugin"
)

//export ConvertHTMLToMarkdown
func ConvertHTMLToMarkdown(html *C.char) *C.char {
	htmlStr := C.GoString(html)
	
	// 预处理HTML，处理微信文章中的懒加载图片
	htmlStr = processWechatLazyImages(htmlStr)
	
	converter := md.NewConverter("", true, nil)
	converter.Use(plugin.GitHubFlavored())

	markdown, err := converter.ConvertString(htmlStr)
	if err != nil {
		// log.Fatal(err)
	}
	return C.CString(markdown)
}

// 处理微信文章中的懒加载图片，将data-src属性值复制到src属性
func processWechatLazyImages(html string) string {
	// 找到所有带data-src属性的img标签
	dataSrcRegex := regexp.MustCompile(`<img[^>]*(data-src=["']([^"']+)["'])[^>]*>`)
	html = dataSrcRegex.ReplaceAllStringFunc(html, func(match string) string {
		// 提取data-src值
		submatch := dataSrcRegex.FindStringSubmatch(match)
		if len(submatch) >= 3 {
			dataSrc := submatch[2]
			
			// 移除懒加载参数
			dataSrc = strings.Replace(dataSrc, "&wx_lazy=1", "", -1)
			dataSrc = strings.Replace(dataSrc, "&wx_co=1", "", -1)
			
			// 如果包含src属性，替换它
			srcRegex := regexp.MustCompile(`src=["'][^"']+["']`)
			if srcRegex.MatchString(match) {
				return srcRegex.ReplaceAllString(match, `src="`+dataSrc+`"`)
			}
			
			// 如果不包含src属性，添加它
			return strings.Replace(match, "<img ", `<img src="`+dataSrc+`" `, 1)
		}
		return match
	})
	
	// 替换所有SVG占位符图片
	svgPlaceholderRegex := regexp.MustCompile(`src=["']data:image/svg[^"']+["']`)
	html = svgPlaceholderRegex.ReplaceAllStringFunc(html, func(match string) string {
		// 查找附近的data-src、data-backsrc等属性
		imgTag := regexp.MustCompile(`<img[^>]*` + regexp.QuoteMeta(match) + `[^>]*>`).FindString(html)
		if imgTag != "" {
			// 尝试找各种可能的属性
			possibleAttrs := []string{"data-src", "data-backsrc", "data-original", "data-failsrc"}
			for _, attr := range possibleAttrs {
				attrRegex := regexp.MustCompile(attr + `=["']([^"']+)["']`)
				attrMatch := attrRegex.FindStringSubmatch(imgTag)
				if len(attrMatch) >= 2 && strings.HasPrefix(attrMatch[1], "http") {
					return `src="` + attrMatch[1] + `"`
				}
			}
		}
		return match
	})

	return html
}

func main() {
	// This function is required for the main package
}
