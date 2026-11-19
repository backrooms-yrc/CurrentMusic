import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';

const periods = { year: '今年', month: '本月', week: '本周', day: '今日' };
const zone = { timeZone: 'Asia/Shanghai' };
const date = new Intl.DateTimeFormat('zh-CN', { ...zone, year: 'numeric', month: 'numeric', day: 'numeric' });
const labels = {
  year: new Intl.DateTimeFormat('zh-CN', { ...zone, month: 'short' }),
  month: new Intl.DateTimeFormat('zh-CN', { ...zone, month: 'numeric', day: 'numeric' }),
  week: new Intl.DateTimeFormat('zh-CN', { ...zone, month: 'numeric', day: 'numeric' }),
  day: new Intl.DateTimeFormat('zh-CN', { ...zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
};
const count = new Intl.NumberFormat('zh-CN');
function bytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(2) : value} ${units[unit]}`;
}

export default function Usage() {
  const [range, setRange] = useState('day');
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let timer;
    async function refresh() {
      try {
        const response = await fetch('/cm/usage', { signal: abort.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const result = await response.json();
        if (!result?.periods?.day) throw new Error('Malformed usage response');
        setData(result);
        setFailed(false);
      } catch {
        if (!abort.signal.aborted) setFailed(true);
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(refresh, 30000);
      }
    }
    refresh();
    return () => { clearTimeout(timer); abort.abort(); };
  }, []);
  const period = data?.periods[range];
  const total = period?.total;

  return <Layout title="服务用量" description="CurrentMusic API 调用次数与歌曲流量">
    <main className="usage-page">
      <h1>服务用量</h1>
      <p>按北京时间统计 CurrentMusic API 调用次数，以及服务端实测和客户端估算的歌曲流量。<Link to="/reference/guide-usage-api">查看统计口径</Link></p>
      <div className="usage-controls">
        <div className="usage-periods" role="group" aria-label="统计周期">
          {Object.entries(periods).map(([key, label]) =>
            <button key={key} type="button" aria-pressed={key === range} onClick={() => setRange(key)}>{label}</button>)}
        </div>
        <span role="status">{failed ? data ? '更新失败 · 显示上次统计' : '暂时无法读取统计'
          : data ? `自 ${date.format(data.since * 1000)} 起采集` : '正在读取统计…'}</span>
      </div>
      {total && <>
        <div className="usage-totals">
          <div><span>API 调用次数</span><strong>{count.format(total.apiCalls)} 次</strong></div>
          <div><span>歌曲流量合计</span><strong>{bytes(total.servedBytes + total.directEstimatedBytes)}</strong></div>
          <div><span>服务器中转 · 实测</span><strong>{bytes(total.servedBytes)}</strong></div>
          <div><span>客户端直连 · 估算</span><strong>{bytes(total.directEstimatedBytes)}</strong></div>
        </div>
        <h2>{periods[range]}明细</h2>
        <div className="usage-table">
          <table aria-label={periods[range] + '服务用量明细'}>
            <thead><tr><th scope="col">时间</th><th scope="col">API 调用</th><th scope="col">中转流量</th><th scope="col">直连估算</th></tr></thead>
            <tbody>{period.series.map((point, i) => {
              const recorded = i === period.series.length - 1 || period.series[i + 1].t > data.since;
              return <tr key={point.t}><th scope="row">{labels[range].format(point.t * 1000)}</th>
                <td>{recorded ? count.format(point.apiCalls) + ' 次' : '—'}</td>
                <td>{recorded ? bytes(point.servedBytes) : '—'}</td>
                <td>{recorded ? bytes(point.directEstimatedBytes) : '—'}</td></tr>;
            })}</tbody>
          </table>
        </div>
      </>}
    </main>
  </Layout>;
}
