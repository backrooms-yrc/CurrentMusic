import React,{useEffect} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import metadata from '../../static/build-info.json';

const cards=[
 ['01','快速开始','从搜索到播放，完成你的第一个接口调用。','quickstart','↗'],
 ['02','API 参考','按功能查找接口，查看参数、权限与返回结构。','endpoints','⌘'],
 ['03','账号与通行证','接入统一账户、授权码与 PKCE 登录流程。','guide-passport-api','◎'],
 ['04','歌词与逐字轴','理解时间轴、翻译与逐字高亮的完整协议。','guide-lyrics-api','≋'],
 ['05','AI 与实时流','构建聊天问答、歌曲卡片与 SSE 流式体验。','guide-currentmusic-ai','✦'],
 ['06','连接与线路','选择访问入口，区分本地与服务端测速。','guide-network-lines-api','⌁'],
];

export default function Home(){
 useEffect(()=>{if(location.hash.startsWith('#/')){let old=location.hash.slice(2).split('?')[0].replace(/\.md$/,'');if(old==='README')old='overview';if(old)location.replace('/api-docs/reference/'+old+'/');}},[]);
 return <Layout title="开发者文档" description="CurrentMusic 完整 API 手册：音乐、账号、歌词与实时互动。">
 <main className="portal">
  <section className="portalHero">
   <div className="heroCopy"><span className="eyebrow"><span/>CURRENTMUSIC DEVELOPERS</span><h1>让音乐，<br/><span>连接更多可能。</span></h1><p>从一次搜索，到完整的音乐体验。<br/>在这里找到 API、接入指南，以及构建下一步所需的一切。</p><div className="heroActions"><Link className="button button--primary button--lg" to="/reference/quickstart">开始接入 <span>→</span></Link><Link className="button button--secondary button--lg" to="/reference/endpoints">浏览 API</Link></div><div className="heroMeta"><span>本机托管</span><i/>中文全文搜索<i/>完整协议参考</div></div>
   <div className="requestCard"><div className="requestTop"><div className="windowDots"><b/><b/><b/></div><span>你的第一个 API 请求</span><small>HTTPS</small></div><div className="requestBody"><span className="codeLabel">REQUEST</span><p><em>GET</em> <span>/cm/health</span></p><pre><span className="codeDim">curl</span> https://music.20110208.xyz/cm/health</pre><div className="responseTitle"><span className="codeLabel">RESPONSE · 结构示例</span><span className="responseBadge">200 OK</span></div><pre className="jsonCode">{'{\n  '}<span>"ok"</span>{': '}<b>true</b>{',\n  '}<span>"now"</span>{': '}<strong>1793450000</strong>{'\n}'}</pre><div className="requestFoot"><span className="waveMark">▂ ▅ █ ▃ ▆</span><span>一个入口，连接整个 Current 生态。</span></div></div></div>
  </section>
  <section className="portalStats"><div><strong>{metadata.backendOperations}</strong><span>自有路由 / 方法组合</span></div><div><strong>{metadata.upstreamPaths}</strong><span>网易云代理登记路径</span></div><div><strong>4</strong><span>主站与镜像入口</span></div><p>从实际路由生成，<br/>让文档跟随实现更新。</p></section>
  <section className="portalSection"><div className="sectionTitle"><div><span className="eyebrow">BUILD SOMETHING GOOD</span><h2>从你正在做的事情开始</h2></div><Link to="/reference/overview">阅读完整手册 →</Link></div><div className="entryGrid">{cards.map(([n,title,desc,route,icon])=><Link className="entryCard" to={'/reference/'+route} key={n}><div className="entryCardTop"><span className="entryIcon">{icon}</span><span className="entryNumber">{n}</span></div><h3>{title}<span>↗</span></h3><p>{desc}</p></Link>)}</div></section>
  <section className="portalBottom"><div><span className="eyebrow">DESIGNED FOR DEVELOPERS</span><h2>不止于列出接口。</h2><p>认证边界、错误处理、缓存策略与完整接入专题，<br/>帮你理解请求前后发生的每一步。</p></div><div className="bottomLinks"><Link to="/reference/conventions">认证、错误与请求约定 <span>→</span></Link><Link to="/reference/guide-third-party-ncm-sync">网易云绑定与同步 <span>→</span></Link><Link to="/reference/guide-rooms-design">一起听与房间协议 <span>→</span></Link></div></section>
 </main></Layout>
}
