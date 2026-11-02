const path=require('node:path'),cp=require('node:child_process');
const result=cp.spawnSync(process.execPath,['--max-old-space-size=1024',path.join(__dirname,'node_modules/@docusaurus/core/bin/docusaurus.mjs'),'build'],{
  cwd:__dirname,stdio:'inherit',env:{...process.env,DOCUSAURUS_SSR_CONCURRENCY:process.env.DOCUSAURUS_SSR_CONCURRENCY||'1'},
});
if(result.error)throw result.error;
process.exitCode=result.status??1;
