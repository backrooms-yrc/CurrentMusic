// 发布已验证的构建；保留历史 hash 资源，旧标签页仍能加载代码块。
const fs=require('node:fs'),path=require('node:path');
const source=path.join(__dirname,'build'),target=path.resolve(__dirname,'../data/api-docs');
if(!fs.existsSync(path.join(source,'index.html')))throw Error('请先 npm run build');
fs.mkdirSync(target,{recursive:true});
function publish(from,to){fs.mkdirSync(to,{recursive:true});fs.chmodSync(to,0o755);const entries=fs.readdirSync(from,{withFileTypes:true}).sort((a,b)=>(a.name==='index.html')-(b.name==='index.html'));for(const item of entries){const src=path.join(from,item.name),dst=path.join(to,item.name);if(item.isDirectory())publish(src,dst);else{const tmp=dst+'.publishing';fs.copyFileSync(src,tmp);fs.chmodSync(tmp,0o644);fs.renameSync(tmp,dst)}}}
publish(source,target);console.log('Published Docusaurus → '+target);
