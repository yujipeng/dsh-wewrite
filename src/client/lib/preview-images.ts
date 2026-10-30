/**
 * 预览 HTML 的正文图占位替换（工作台看图）。
 * host 渲染的 `![alt](图片待生成)` 会保留为 `<img src="ww-image-placeholder">`；
 * 预览时按 bodyImageIds 顺序替换为 image/get 读取的 data URL，无对应图则删除占位。
 */

const IMAGE_PLACEHOLDER_TAG = /<img\b[^>]*?\bsrc="ww-image-placeholder"[^>]*>/gi;

export function resolvePreviewImages(html: string, bodyImageUrls: readonly string[]): string {
  let index = 0;
  return html.replace(IMAGE_PLACEHOLDER_TAG, () => {
    const url = bodyImageUrls[index];
    index += 1;
    return url ? `<img src="${url}" alt="正文配图" style="max-width:100%;height:auto;" />` : '';
  });
}
