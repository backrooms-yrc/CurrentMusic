const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const raw = path.join(__dirname, '.generated/raw');
const content = path.join(__dirname, '.generated/content');
fs.mkdirSync(content,{recursive:true});
cp.execFileSync('python3',[path.join(root,'tools/build-api-docs.py'),'--output',raw],{stdio:'inherit'});
const sidebar = fs.readFileSync(path.join(raw,'_sidebar.md'),'utf8');
const groups = [];
for(const line of sidebar.split('\n')){
  const category = line.match(/^- \*\*(.+)\*\*$/);
  if(category)groups.push({type:'category',label:category[1],collapsed:groups.length>0,items:[]});
  const link = line.match(/^  - \[(.+)\]\((.+)\.md\)$/);
  if(link)groups.at(-1).items.push({type:'doc',id:link[2]==='README'?'overview':link[2],label:link[1]});
}
for(const name of fs.readdirSync(raw).filter(x=>x.endsWith('.md')&&!x.startsWith('_'))){
  let text = fs.readFileSync(path.join(raw,name),'utf8');
  text = text.replace(/\]\(README\.md/g,'](overview.md');
  const upstreamAnchors=Object.fromEntries([...text.matchAll(/^## (\/cm\/ncm\/\S+)\n\n([^\n]+)/gm)].map(([,route,title])=>[title,route.replace(/\//g,'').toLowerCase()]));
  text=text.replace(/\]\(#([^)]+)\)/g,(link,title)=>upstreamAnchors[title]?'](#'+upstreamAnchors[title]+')':link);
  text = text.replace(/<code>([\s\S]*?)<\/code>/g,(_,value)=>'`'+value.replace(/&(?:#x27|quot|lt|gt|amp);/g,entity=>({'&#x27;':"'",'&quot;':'"','&lt;':'<','&gt;':'>','&amp;':'&'}[entity])).replace(/`/g,'\u02cb').replace(/\|/g,'\\|')+'`');
  text = text.replace(/\]\((manifest\.json|build-info\.json|licenses\/[^)]+)\)/g,'](/api-docs/$1)');
  text = text.replace(/\]\((\/[^)]+)\)/g,'](pathname://$1)');
  fs.writeFileSync(path.join(content,name==='README.md'?'overview.md':name),text);
}
fs.writeFileSync(path.join(__dirname,'.generated/sidebars.json'),JSON.stringify({handbook:groups},null,2));
fs.copyFileSync(path.join(raw,'manifest.json'),path.join(__dirname,'static/manifest.json'));
const metadata=JSON.parse(fs.readFileSync(path.join(raw,'build-info.json'),'utf8'));
metadata.siteEngine='Docusaurus';metadata.siteEngineVersion='3.10.2';
fs.writeFileSync(path.join(__dirname,'static/build-info.json'),JSON.stringify(metadata,null,2));
fs.cpSync(path.join(raw,'licenses'),path.join(__dirname,'static/licenses'),{recursive:true});
