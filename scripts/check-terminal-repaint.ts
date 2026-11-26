// Chromium regression probe for the synthetic read-only fixture. No terminal input.
import { startBrowserReview } from './browser-review';
const server = await startBrowserReview();
const session = `repaint-${process.pid}`;
async function browser(...args:string[]) {
  const p = Bun.spawn(['agent-browser','--session',session,...args], { stdout:'pipe',stderr:'pipe' });
  const [out,err,code] = await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  if (code) throw new Error(`${args[0]} (${code}): ${err} ${out}`);
  return out.trim();
}
const pixels = `['supervisor','reviewer'].map(name=>document.querySelector('.stage-grid [data-pane="'+name+'"] canvas')).filter(Boolean).map(c=>{const im=c.getContext('2d').getImageData(0,0,c.width,18);return [24,25,26,27].map(col=>{let n=0;for(let y=0;y<18;y++)for(let x=Math.floor(col*c.width/80);x<Math.floor((col+1)*c.width/80);x++)if(im.data[(y*c.width+x)*4]>100)n++;return n})})`;
async function check(label:string) {
  await browser('wait','--fn',`(()=>{const rows=${pixels};return rows.length===2 && rows.every(r=>r[0]>0&&r[1]>0)})()`);
  const rows = JSON.parse(await browser('eval',pixels)) as number[][];
  if (!(rows[0]![2]!>0 && rows[0]![3]!>0 && rows[1]![2]===0 && rows[1]![3]===0)) throw new Error(`${label}: stale or missing glyphs ${JSON.stringify(rows)}`);
  console.log(label, rows);
}
try {
  await browser('set','viewport','1440','900');
  await browser('open',`${server.url}?view=terminals&host=alpha`);
  await check('initial');
  for (let i=0;i<3;i++) {
    await browser('click','.hostbutton[data-host=beta]'); await browser('click','.hostbutton[data-host=alpha]');
    await browser('click','nav [data-view=terminals]','--first'); await check(`rebuild ${i+1}`);
  }
} finally { try { await browser('close'); } finally { server.stop(true); } }
