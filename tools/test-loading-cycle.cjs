// CM_PLAYWRIGHT_MODULE=/path/to/playwright CM_CHROMIUM_EXECUTABLE=/path/to/chrome node tools/test-loading-cycle.cjs
const {chromium,devices}=require(process.env.CM_PLAYWRIGHT_MODULE||'playwright');
const {buildSync}=require('../web/node_modules/esbuild');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),base='https://music.20110208.xyz/app/';
const fixture=buildSync({stdin:{contents:`export * from './web/src/loading.js'; export * from './web/src/page-motion.js';export * from './web/src/ptr.js';`,resolveDir:root},bundle:true,format:'iife',globalName:'Loading',loader:{'.svg':'text'},write:false,outfile:'fixture.js'}).outputFiles.find(x=>x.path.endsWith('.js')).text;
const css=fs.readFileSync(path.join(root,'web/src/loading-indicator.css'),'utf8');
(async()=>{const browser=await chromium.launch({...(process.env.CM_CHROMIUM_EXECUTABLE?{executablePath:process.env.CM_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});try{
 const checks=[false,true].map(async reduced=>{
  const ctx=await browser.newContext({reducedMotion:reduced?'reduce':'no-preference',...devices['iPhone 13']}),page=await ctx.newPage();
  await page.setContent(`<style>${css}#out{position:relative;height:600px;overflow:auto}#ptrInd{position:fixed;top:10px;left:10px;opacity:0;width:40px;height:40px}</style><main id="out"></main>`);
  await page.addScriptTag({content:fixture});
  await page.evaluate(()=>{window.show=Loading.createPageMotion(document.getElementById('out'));window.started=performance.now();window.completed=0;show(el=>{el.innerHTML='<h1>Instant page</h1>';}).then(()=>{completed=performance.now();});});
  await page.locator('.cm-route-loading').waitFor();await page.waitForTimeout(600);
  assert.equal(await page.evaluate(()=>completed),0,'instant page still must show a full cycle');
  assert.equal(await page.locator('.cm-route-loading .cm-loading-indicator').count(),1);
  await page.waitForFunction(()=>completed>0);assert(await page.evaluate(()=>completed-started>=4500));
  assert.equal(await page.locator('.cm-route-loading').count(),0);
  assert.equal(await page.locator('[inert]').count(),0);
  // Skeleton pages never receive a competing full-page overlay; native determinate progress stays intact.
  await page.evaluate(async()=>{await show(el=>{el.innerHTML='<div class="cm-skeleton"><div class="sk"></div></div><mdui-linear-progress value=".3"></mdui-linear-progress>';});});
  assert.equal(await page.locator('.cm-route-loading').count(),0);
  await page.evaluate(()=>{const out=document.getElementById('out');out.innerHTML='<div id="touchTarget">Refresh me</div>';Loading.initExpressiveLoading();Loading.initPullToRefresh(()=>{window.calls=(window.calls||0)+1;return window.refreshAction==='error'?Promise.reject(Error('fixture')):window.refreshAction==='slow'?new Promise(r=>setTimeout(r,5100)):Promise.resolve();});
    window.pull=()=>{const target=document.getElementById('touchTarget'),t=(y)=>new Touch({identifier:1,target,clientX:40,clientY:y});target.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[t(100)]}));target.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:[t(200)]}));target.dispatchEvent(new TouchEvent('touchend',{bubbles:true,changedTouches:[t(200)]}));};});
  for(const action of ['fast','error','slow']){
   await page.evaluate(action=>{window.refreshAction=action;window.refreshStarted=performance.now();pull();},action);
   await page.waitForFunction(()=>document.getElementById('ptrInd').classList.contains('spin'));
   await page.waitForTimeout(600);assert.equal(await page.locator('#ptrInd').getAttribute('aria-hidden'),'false');
   assert.equal(await page.locator('#ptrInd .cm-loading-indicator').count(),1);
   await page.waitForFunction(()=>!document.getElementById('ptrInd').classList.contains('spin'),{},{timeout:12000});
   const elapsed=await page.evaluate(()=>performance.now()-refreshStarted);
   assert(elapsed>=4500);if(action==='slow')assert(elapsed>=9000,'slow refresh must end at a later complete cycle boundary');
  }
  await page.evaluate(()=>{window.refreshAction='slow';pull();window.dispatchEvent(new HashChangeEvent('hashchange'));});
  assert.equal(await page.locator('#ptrInd').getAttribute('aria-hidden'),'true');
  // Asynchronous tab/panel spinners are upgraded too; progress percentages are preserved.
  await page.evaluate(()=>{document.getElementById('out').innerHTML='<mdui-circular-progress></mdui-circular-progress><mdui-linear-progress value=".7"></mdui-linear-progress>';});
  await page.locator('#out .cm-expressive-loading').waitFor();assert.equal(await page.locator('#out mdui-linear-progress[value]').count(),1);
  console.log('PASS',reduced?'reduced static':'morphing','instant routes, skeleton exclusion, full refresh cycles for fast/error/slow requests, cancellation, dynamic spinner upgrade');await ctx.close();
 });
 const bootChecks=[false,true].map(async reduced=>{
  const ctx=await browser.newContext({reducedMotion:reduced?'reduce':'no-preference'}),page=await ctx.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('cm.recReset','rec-1.28.74');window.bootRemovedAt=0;new MutationObserver(()=>{if(!document.getElementById('boot')&&window.__cmBooted&&!window.bootRemovedAt)window.bootRemovedAt=performance.now();}).observe(document,{childList:true,subtree:true});});
  await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.pathname.startsWith('/app/')){const file=path.join(root,'app/src/main/assets/www',u.pathname.slice(5)||'index.html');if(fs.existsSync(file))return route.fulfill({path:file});}return route.fulfill({json:{}});});
  for(const operation of ['open','reload']){
   if(operation==='open')await page.goto(base+'#/settings');else await page.reload();
   assert(await page.locator('#boot').isVisible());assert.equal(await page.evaluate(()=>bootRemovedAt),0);
   await page.locator('#boot').waitFor({state:'detached',timeout:10000});
   assert(await page.evaluate(()=>bootRemovedAt>=4500));
   assert.equal(await page.locator('.cm-route-loading').count(),0,'boot does not trigger a second page cycle');
  }
  // Non-skeleton routes, including static legal/settings pages, use the common indicator.
  await page.evaluate(()=>{location.hash='#/legal/privacy';});await page.locator('.cm-route-loading').waitFor();
  await page.locator('.cm-route-loading').waitFor({state:'detached',timeout:10000});assert.deepEqual(errors,[]);
  console.log('PASS app boot',reduced?'reduced static':'morphing','open/reload always complete a cycle, static page loading, no duplicate boot cycle or errors');await ctx.close();
 });
 const slowBoot=(async()=>{
  const ctx=await browser.newContext(),page=await ctx.newPage();
  await page.addInitScript(()=>{localStorage.setItem('cm.recReset','rec-1.28.74');});
  await page.route('**/*',async route=>{const u=new URL(route.request().url());
    if(u.pathname==='/app/app.js')await new Promise(r=>setTimeout(r,5100));
    if(u.pathname.startsWith('/app/')){const file=path.join(root,'app/src/main/assets/www',u.pathname.slice(5)||'index.html');if(fs.existsSync(file))return route.fulfill({path:file});}
    return route.fulfill({json:{}});
  });
  await page.goto(base+'#/settings');
  assert(await page.locator('#boot').isVisible(),'slow main bundle must not cut the second shape cycle');
  await page.locator('#boot').waitFor({state:'detached',timeout:12000});
  assert(await page.evaluate(()=>performance.now()>=9000));
  console.log('PASS delayed bundle completes the next seven-shape boundary without restarting the boot timeline');await ctx.close();
 })();
 const results=await Promise.allSettled([...checks,...bootChecks,slowBoot]);for(const r of results)if(r.status==='rejected')throw r.reason;
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
