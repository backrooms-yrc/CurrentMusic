// CM_PLAYWRIGHT_MODULE=/path/to/playwright CM_CHROMIUM_EXECUTABLE=/path/to/chrome node tools/test-page-motion.cjs
const { chromium, devices } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { buildSync } = require('../web/node_modules/esbuild');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const motion = buildSync({entryPoints:[path.join(root,'web/src/page-motion.js')],bundle:true,format:'iife',globalName:'Motion',loader:{'.svg':'text','.css':'empty'},write:false}).outputFiles[0].text;
const base = 'https://music.20110208.xyz/app/';
const asset = request => path.join(root, 'app/src/main/assets/www', new URL(request.url()).pathname.slice(5) || 'index.html');
(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? {executablePath:process.env.CM_CHROMIUM_EXECUTABLE} : {}),args:['--no-sandbox'] });
  try {
    for (const reduce of [false, true]) {
      const context = await browser.newContext({reducedMotion:reduce?'reduce':'no-preference'});
      const page = await context.newPage();
      await page.setContent('<main id="out" style="height:160px;overflow:auto"></main>');
      await page.addScriptTag({content:motion});
      await page.evaluate(()=>Object.defineProperty(Animation.prototype,'finished',{get:()=>undefined,configurable:true}));
      await page.evaluate(async () => {
        const navigate = Motion.createPageMotion(document.getElementById('out'));
        window.show = (render, back) => navigate(render, back, {refresh:true});
        await show(el => {el.innerHTML='<div style="height:1000px">First</div>';});
      });
      assert.equal(await page.evaluate(()=>document.querySelector('#out').getAnimations({subtree:true}).length>0),!reduce);
      await page.evaluate(async () => {
        let finish;
        const slow=show(el=>{el.innerHTML='<div class="cm-skeleton"><div class="sk"></div></div>';return new Promise(r=>{finish=()=>{el.innerHTML='<div>Stale page</div>';r();};});});
        // Wait until the slow route has mounted, then start two overlapping navigations.
        while(!finish) await new Promise(r=>setTimeout(r,10));
        const second=show(el=>{el.textContent='Interrupted';});
        const last=show(el=>{el.innerHTML='<div style="height:1000px">Latest</div>';});
        await Promise.all([second,last]);
        document.getElementById('out').scrollTop=120;
        finish(); await slow;
      });
      assert.equal(await page.locator('#out').innerText(),'Latest');
      assert.equal(await page.evaluate(()=>document.getElementById('out').scrollTop),120);
      await page.evaluate(async()=>{await show(()=>{throw Error('<img src=x>');});});
      assert((await page.locator('.cm-empty').innerText()).includes('<img src=x>'));
      assert.equal(await page.locator('.cm-empty img').count(),0);
      // Animation API fallback must mount immediately and remain usable.
      await page.evaluate(async()=>{Element.prototype.animate=undefined;await show(el=>{el.textContent='Fallback';});});
      assert.equal(await page.locator('#out').innerText(),'Fallback');
      console.log('PASS route lifecycle:',reduce?'reduced motion':'motion','rapid navigation, stale completion, scroll, escaped error, API fallback');
      await context.close();
    }
    for (const reduce of [false, true]) {
      const context=await browser.newContext({...devices['iPhone 13'],reducedMotion:reduce?'reduce':'no-preference'});
      const page=await context.newPage(); let release;
      const gate=new Promise(r=>{release=r;});
      await page.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(u.pathname==='/app/app.js') {await gate;return route.abort();}
        if(u.pathname.startsWith('/app/') && fs.existsSync(asset(route.request()))) return route.fulfill({path:asset(route.request())});
        return route.fulfill({json:{}});
      });
      await page.goto(base,{waitUntil:'commit'});
      await page.locator('#boot svg').waitFor({state:'visible'});
      assert.equal((await page.locator('#boot').innerText()).trim(),'');
      assert.equal(await page.locator('#boot .cm-indicator-morph').evaluate(e=>getComputedStyle(e).animationIterationCount),reduce?'1':'infinite');
      const initial=await page.evaluate(()=>document.querySelector('#boot .cm-indicator-turn path').getTotalLength());
      await page.waitForTimeout(700);
      const after=await page.evaluate(()=>document.querySelector('#boot .cm-indicator-turn path').getTotalLength());
      if(!reduce) assert(Math.abs(after-initial)>1,'SVG must morph before JS loads');
      assert.equal(await page.locator('#boot .cm-indicator-turn').evaluate(e=>getComputedStyle(e).display==='none'),reduce);
      release();await page.getByText('启动失败：脚本资源加载失败').waitFor();
      console.log('PASS pre-bundle boot:',reduce?'reduced motion static shape':'seven-shape morph','no visible loading text; diagnostics preserved');
      await context.close();
    }
    for(const mobile of [false,true]) {
      const context=await browser.newContext(mobile?devices['iPhone 13']:{viewport:{width:1440,height:1000}});
      const page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{localStorage.setItem('cm.recReset','rec-1.28.74');localStorage.setItem('cm.uiPreset','md3');});
      await page.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(u.pathname.startsWith('/app/') && fs.existsSync(asset(route.request()))) return route.fulfill({path:asset(route.request())});
        if(u.pathname==='/cm/ncm/album') {await new Promise(r=>setTimeout(r,1100));return route.fulfill({json:{id:1,name:'Fixture Album',artist:'Test Artist',songs:[]}});}
        if(u.pathname==='/cm/ncm/song/detail') {await new Promise(r=>setTimeout(r,900));return route.fulfill({json:{songs:[{ncm_id:1,name:'Fixture Song',artists:'Test Artist',album:'Test Album'}]}});}
        if(u.pathname==='/cm/ncm/artist') {await new Promise(r=>setTimeout(r,900));return route.fulfill({json:{id:1,name:'Fixture Artist',songs:[],albums:[]}});}
        if(['/cm/ncm/mv/detail','/cm/ncm/video/detail'].includes(u.pathname)) {await new Promise(r=>setTimeout(r,900));return route.fulfill({json:{data:{id:1,vid:'abc',name:'Fixture Video',title:'Fixture Video'}}});}
        if(u.pathname.startsWith('/cm/users/')) {await new Promise(r=>setTimeout(r,900));return route.fulfill({status:503,json:{error:'fixture unavailable'}});}
        return route.fulfill({json:{}});
      });
      await page.goto(base+'#/album/1');await page.locator('.cm-skel-detail').waitFor();
      assert(await page.locator('.sk').first().evaluate(e=>getComputedStyle(e).backgroundColor!=='rgba(0, 0, 0, 0)'));
      await page.screenshot({path:'/tmp/cm-album-skeleton-'+(mobile?'mobile':'desktop')+'.png'});
      await page.getByText('Fixture Album',{exact:true}).waitFor();assert.equal(await page.locator('.cm-skel-detail').count(),0);
      await page.evaluate(()=>{location.hash='#/song/1';});await page.locator('.cm-skel-songpage').waitFor();await page.getByText('Fixture Song',{exact:true}).waitFor();
      await page.evaluate(()=>{location.hash='#/artist/1';});await page.locator('.cm-skel-detail').waitFor();await page.getByText('Fixture Artist',{exact:true}).waitFor();
      await page.evaluate(()=>{location.hash='#/mv/1';});await page.locator('.cm-skel-media').waitFor();await page.getByText('Fixture Video',{exact:true}).waitFor();
      await page.evaluate(()=>{location.hash='#/video/abc';});await page.locator('.cm-skel-media').waitFor();await page.getByText('Fixture Video',{exact:true}).waitFor();
      // Navigate away before the detail response. Its completion must not overwrite/scroll settings.
      await page.evaluate(()=>{location.hash='#/album/1';});await page.locator('.cm-skel-detail').waitFor();
      await page.evaluate(()=>{location.hash='#/settings';});await page.locator('.cm-settings-hub').waitFor();
      await page.waitForTimeout(1200);assert.equal(await page.locator('.cm-settings-hub').count(),1);
      assert.equal(await page.locator('#out > .cm-route-page').count(),1);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.deepEqual(errors,[]);
      console.log('PASS app:',mobile?'mobile':'desktop','detail skeletons, real-content replacement, theme fill, fast navigation, no errors/overflow');
      await context.close();
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
