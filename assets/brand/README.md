# CurrentMusic 品牌图标

用户选定的「声流 C＋播放键」方案，浅鼠尾草绿底（#E7EFE6）与深墨绿图形（#183E34）。

- `currentmusic-icon-master.png`：用户选定的原始透明 PNG，保留原图。
- `currentmusic-icon.png`：512px 通用图标。
- `python3 tools/build-brand-assets.py`：从原图生成网站、分享封面、文档与 Android 图标，需要 ImageMagick 和 rsvg-convert。
- 网站与文档的 SVG 是内嵌 PNG 的兼容封装，保持现有地址可用，并非矢量重绘。
- Android 同时包含传统密度图标与 API 26+ 自适应图标；更新安装包后才会替换已安装图标。

生成方式：内置 image_gen。最终提示词：

> Recolor and clean this CurrentMusic app icon. The user strongly dislikes the existing vivid blue-purple palette. Replace it completely with an exceptionally refined restrained botanical two-color palette: a solid very pale sage green rounded-square tile (#E7EFE6), and the entire C/current/play symbol in solid deep forest ink green (#183E34). NO blue, NO purple, NO indigo, NO neon, NO gradients, NO glossy shading. Keep the recognizable flowing C monogram and right-facing play triangle, preserve their existing shapes, positions, visual proportions and generous rounded-square corners. Flat precise high-contrast artwork, modern Material Design 3 feeling, quiet natural colors, elegant app branding. Clean up ALL stray pixels and blue speckles in the margins: outside the rounded tile must be entirely transparent and perfectly clean. Crisp smooth silhouette and rounded corners. Single standalone icon centered with equal narrow transparent margin. No text, no mockup, no 3D, no shadows, no ornament, no alternative versions.
