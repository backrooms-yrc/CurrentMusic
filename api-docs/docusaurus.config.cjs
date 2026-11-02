module.exports = {
  title: 'CurrentMusic Developers',
  tagline: '音乐、账户与实时互动，一份完整的接入指南。',
  url: 'https://music.20110208.xyz', baseUrl: '/api-docs/',
  favicon: 'img/logo.svg?v=sage1', trailingSlash: true,
  organizationName: 'backrooms-yrc', projectName: 'CurrentMusic',
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: {format: 'md', hooks: {onBrokenMarkdownLinks: 'throw', onBrokenMarkdownImages: 'throw'}},
  i18n: {defaultLocale: 'zh-Hans', locales: ['zh-Hans']},
  presets: [['classic', {
    docs: {path: '.generated/content', routeBasePath: 'reference', sidebarPath: require.resolve('./.generated/sidebars.json'), sidebarCollapsible: true,
      sidebarCollapsed: true, showLastUpdateTime: false},
    blog: false, theme: {customCss: require.resolve('./src/css/custom.css')},
  }]],
  themes: [['@easyops-cn/docusaurus-search-local', {
    hashed: true, language: ['en','zh'], indexDocs: true, indexBlog: false, indexPages: true,
    docsDir: '.generated/content', docsRouteBasePath: '/reference', highlightSearchTermsOnTargetPage: true,
  }]],
  themeConfig: {
    colorMode: {defaultMode: 'light', respectPrefersColorScheme: true},
    navbar: {title: 'CurrentMusic', logo: {alt:'CurrentMusic',src:'img/logo.svg?v=sage1'}, items: [
      {to:'/reference/overview',label:'文档',position:'left'},
      {to:'/reference/endpoints',label:'API 参考',position:'left'},
      {href:'https://music.20110208.xyz/app/auto',label:'线路测速',position:'left'},
      {href:'https://music.20110208.xyz/developer',label:'开发者平台',position:'right'},
      {href:'https://music.20110208.xyz/app/',label:'打开音乐',position:'right'},
    ]},
    footer: {style:'dark', links:[
      {title:'接入指南',items:[{label:'快速开始',to:'/reference/quickstart'},{label:'认证与请求约定',to:'/reference/conventions'}]},
      {title:'开放能力',items:[{label:'通行证',to:'/reference/guide-passport-api'},{label:'API 完整索引',to:'/reference/endpoints'}]},
      {title:'CurrentMusic',items:[{label:'账户控制台',href:'https://music.20110208.xyz/station'},{label:'隐私政策',href:'https://music.20110208.xyz/app/#/legal/privacy'},{label:'用户协议',href:'https://music.20110208.xyz/app/#/legal/terms'},{label:'来源与许可',to:'/reference/about'}]},
    ],copyright:'CurrentMusic Developers · Built with Docusaurus'},
    prism: {additionalLanguages:['bash','json','python','javascript']},
    tableOfContents: {minHeadingLevel:2,maxHeadingLevel:3},
    docs: {sidebar: {hideable:true,autoCollapseCategories:true}},
  },
};
