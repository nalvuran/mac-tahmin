// Maç Tahmin - model (Poisson + Dixon-Coles). Tarayıcıda window.Model, Node'da module.exports.
(function (root) {
  // Varsayılan ayarlar; otomatik ayar ile değiştirilebilir.
  const DEF = { cap: 4, halfLife: 90, prior: 4, stretch: 1 };
  let PAR = Object.assign({}, DEF);
  function setParams(p) { PAR = Object.assign({}, DEF, p || {}); }
  const RHO = -0.08;      // Dixon-Coles düşük skor düzeltmesi
  const MAXG = 8;

  // fixtures: [{home, away, hg, ag, ts}] (ts: saniye)
  function fitRatings(fixtures, nowTs, par, iters) {
    nowTs = nowTs || Date.now() / 1000;
    par = par || PAR; const CAP = par.cap, HALF_LIFE = par.halfLife, PRIOR_GAMES = par.prior;
    const teams = new Set();
    fixtures.forEach(f => { teams.add(f.home); teams.add(f.away); });
    const att = {}, def = {};
    teams.forEach(t => { att[t] = 1; def[t] = 1; });
    const w = fixtures.map(f => Math.pow(0.5, Math.max(0, (nowTs - f.ts) / 86400) / HALF_LIFE));
    let sw = 0, sh = 0, sa = 0;
    fixtures.forEach((f, i) => { sw += w[i]; sh += w[i] * Math.min(f.hg, CAP); sa += w[i] * Math.min(f.ag, CAP); });
    let muH = sw > 0 ? sh / sw : 1.5, muA = sw > 0 ? sa / sw : 1.2;
    if (fixtures.length < 20) { muH = (muH * fixtures.length + 1.5 * 20) / (fixtures.length + 20); muA = (muA * fixtures.length + 1.2 * 20) / (fixtures.length + 20); }
    const m = (muH + muA) / 2;
    for (let it = 0; it < (iters || 60); it++) {
      const aN = {}, aD = {}, dN = {}, dD = {};
      teams.forEach(t => { aN[t] = PRIOR_GAMES * m; aD[t] = PRIOR_GAMES * m; dN[t] = PRIOR_GAMES * m; dD[t] = PRIOR_GAMES * m; });
      fixtures.forEach((f, i) => {
        const hg = Math.min(f.hg, CAP), ag = Math.min(f.ag, CAP), wi = w[i];
        aN[f.home] += wi * hg; aD[f.home] += wi * muH * def[f.away];
        aN[f.away] += wi * ag; aD[f.away] += wi * muA * def[f.home];
        dN[f.home] += wi * ag; dD[f.home] += wi * muA * att[f.away];
        dN[f.away] += wi * hg; dD[f.away] += wi * muH * att[f.home];
      });
      let ma = 0, md = 0, n = 0;
      teams.forEach(t => { att[t] = aN[t] / aD[t]; def[t] = dN[t] / dD[t]; ma += att[t]; md += def[t]; n++; });
      ma /= n; md /= n;
      teams.forEach(t => { att[t] /= ma; def[t] /= md; });
    }
    return { att, def, muH, muA, n: fixtures.length };
  }

  function pois(l, k) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }

  function matrix(lh, la) {
    const M = []; let s = 0;
    for (let i = 0; i <= MAXG; i++) {
      M[i] = [];
      for (let j = 0; j <= MAXG; j++) {
        let t = 1;
        if (i === 0 && j === 0) t = 1 - lh * la * RHO;
        else if (i === 0 && j === 1) t = 1 + lh * RHO;
        else if (i === 1 && j === 0) t = 1 + la * RHO;
        else if (i === 1 && j === 1) t = 1 - RHO;
        M[i][j] = Math.max(0, pois(lh, i) * pois(la, j) * t); s += M[i][j];
      }
    }
    for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) M[i][j] /= s;
    return M;
  }

  function markets(M) {
    const sum = fn => { let s = 0; for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) if (fn(i, j)) s += M[i][j]; return s; };
    const r = {
      home: sum((i, j) => i > j), draw: sum((i, j) => i === j), away: sum((i, j) => i < j),
      bttsYes: sum((i, j) => i > 0 && j > 0),
      homeScores: sum(i => i > 0), awayScores: sum((i, j) => j > 0),
      over: {}, under: {}
    };
    r.bttsNo = 1 - r.bttsYes; r.homeOrDraw = r.home + r.draw; r.awayOrDraw = r.away + r.draw; r.homeOrAway = r.home + r.away;
    [0.5, 1.5, 2.5, 3.5, 4.5].forEach(l => { r.over[l] = sum((i, j) => i + j > l); r.under[l] = 1 - r.over[l]; });
    const scores = [];
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) scores.push({ h: i, a: j, p: M[i][j] });
    scores.sort((a, b) => b.p - a.p);
    r.topScores = scores.slice(0, 5);
    return r;
  }

  // xG ile hücum/savunma düzeltme çarpanı (0.6 xG + 0.4 gol)
  function xgFactor(goals, xg) {
    if (!(goals > 0) || !(xg > 0)) return 1;
    return Math.min(1.3, Math.max(0.7, (0.6 * xg + 0.4 * goals) / goals));
  }

  // opts: {homeAdj:{att,def}, awayAdj:{att,def}} yüzde; xg: {home:{gf,ga,xgf,xga}, away:{...}}
  function predict(R, homeId, awayId, opts) {
    opts = opts || {};
    const k = (opts.par || PAR).stretch || 1; // güç farkını aç (favori olasılığı kalibrasyonu)
    let aH = Math.pow(R.att[homeId] || 1, k), dH = Math.pow(R.def[homeId] || 1, k), aA = Math.pow(R.att[awayId] || 1, k), dA = Math.pow(R.def[awayId] || 1, k);
    const xg = opts.xg;
    if (xg && xg.home) { aH *= xgFactor(xg.home.gf, xg.home.xgf); dH *= xgFactor(xg.home.ga, xg.home.xga); }
    if (xg && xg.away) { aA *= xgFactor(xg.away.gf, xg.away.xgf); dA *= xgFactor(xg.away.ga, xg.away.xga); }
    const ha = opts.homeAdj || {}, aa = opts.awayAdj || {};
    let lh = R.muH * aH * dA * (1 + (ha.att || 0) / 100) * (1 + (aa.def || 0) / 100);
    let la = R.muA * aA * dH * (1 + (aa.att || 0) / 100) * (1 + (ha.def || 0) / 100);
    lh = Math.max(0.15, lh); la = Math.max(0.15, la);
    const M = matrix(lh, la);
    return { lh, la, M, mk: markets(M), ratings: { aH, dH, aA, dA } };
  }

  // Geriye dönük test: her maçı sadece o günden önceki sonuçlarla tahmin et.
  // fixtures: [{home, away, hg, ag, ts, hn, an}] zamana göre sıralı. minGames: tahmine başlamadan önce gereken maç sayısı.
  function backtest(fixtures, minGames, par, iters) {
    minGames = minGames || 40;
    const fx = fixtures.slice().sort((a, b) => a.ts - b.ts);
    const preds = [];
    let i = 0, R = null, lastDay = null;
    // ilk maçlardaki ev/beraberlik/deplasman oranları (taban çizgisi)
    while (i < fx.length) {
      const day = Math.floor(fx[i].ts / 86400);
      if (i >= minGames) {
        if (day !== lastDay) { R = fitRatings(fx.slice(0, i), fx[i].ts, par, iters); lastDay = day; }
        const f = fx[i];
        if (R.att[f.home] && R.att[f.away]) {
          const P = predict(R, f.home, f.away, { par: par || PAR });
          const past = fx.slice(0, i);
          const base = {
            home: past.filter(x => x.hg > x.ag).length / past.length,
            draw: past.filter(x => x.hg === x.ag).length / past.length
          };
          base.away = 1 - base.home - base.draw;
          preds.push({ f, mk: P.mk, lh: P.lh, la: P.la, base });
        }
      }
      i++;
    }
    return summarize(preds);
  }

  function summarize(preds) {
    const n = preds.length;
    const res = p => p.f.hg > p.f.ag ? 'home' : p.f.hg < p.f.ag ? 'away' : 'draw';
    let favHit = 0, brier = 0, brierBase = 0, ll = 0, llBase = 0, exact = 0, homeAlways = 0;
    const cal = {}; // olasılık dilimleri: tahmin edilen favorinin gerçekleşme oranı
    const bin = p => Math.min(9, Math.floor(p * 10));
    const yesNo = { btts: [0, 0], o25: [0, 0], o15: [0, 0] }; // [doğru, toplam]
    const conf = []; // "en yüksek ihtimal" kategorileri
    const cats = {
      '1.5 üst': (p, f) => [p.mk.over[1.5], f.hg + f.ag > 1.5],
      '2.5 üst': (p, f) => [p.mk.over[2.5], f.hg + f.ag > 2.5],
      '2.5 alt': (p, f) => [p.mk.under[2.5], f.hg + f.ag < 2.5],
      '3.5 alt': (p, f) => [p.mk.under[3.5], f.hg + f.ag < 3.5],
      'KG var': (p, f) => [p.mk.bttsYes, f.hg > 0 && f.ag > 0],
      'KG yok': (p, f) => [p.mk.bttsNo, !(f.hg > 0 && f.ag > 0)],
      'Ev sahibi kaybetmez (1X)': (p, f) => [p.mk.homeOrDraw, f.hg >= f.ag],
      'Deplasman kaybetmez (X2)': (p, f) => [p.mk.awayOrDraw, f.ag >= f.hg],
      'Favori kazanır': (p, f) => { const h = p.mk.home >= p.mk.away; return [h ? p.mk.home : p.mk.away, h ? f.hg > f.ag : f.ag > f.hg]; }
    };
    const thr = {}; Object.keys(cats).forEach(k => thr[k] = { all: [0, 0], hi: [0, 0], pSum: 0 });
    preds.forEach(p => {
      const r = res(p), mk = p.mk, f = p.f;
      const probs = { home: mk.home, draw: mk.draw, away: mk.away };
      const pick = Object.keys(probs).reduce((a, b) => probs[a] >= probs[b] ? a : b);
      if (pick === r) favHit++;
      if (r === 'home') homeAlways++;
      ['home', 'draw', 'away'].forEach(k => {
        brier += Math.pow(probs[k] - (k === r ? 1 : 0), 2);
        brierBase += Math.pow(p.base[k] - (k === r ? 1 : 0), 2);
      });
      ll += -Math.log(Math.max(1e-6, probs[r])); llBase += -Math.log(Math.max(1e-6, p.base[r]));
      const pf = probs[pick], b = bin(pf);
      cal[b] = cal[b] || { n: 0, hit: 0, p: 0 }; cal[b].n++; cal[b].p += pf; if (pick === r) cal[b].hit++;
      if (mk.topScores[0].h === f.hg && mk.topScores[0].a === f.ag) exact++;
      const btts = f.hg > 0 && f.ag > 0;
      yesNo.btts[1]++; if ((mk.bttsYes >= 0.5) === btts) yesNo.btts[0]++;
      yesNo.o25[1]++; if ((mk.over[2.5] >= 0.5) === (f.hg + f.ag > 2.5)) yesNo.o25[0]++;
      yesNo.o15[1]++; if ((mk.over[1.5] >= 0.5) === (f.hg + f.ag > 1.5)) yesNo.o15[0]++;
      Object.keys(cats).forEach(k => {
        const [pp, ok] = cats[k](p, f), t = thr[k];
        t.all[1]++; if (ok) t.all[0]++; t.pSum += pp;
        if (pp >= 0.7) { t.hi[1]++; if (ok) t.hi[0]++; }
      });
    });
    return {
      n, favHit: favHit / n, homeAlways: homeAlways / n,
      brier: brier / n, brierBase: brierBase / n, ll: ll / n, llBase: llBase / n,
      exact: exact / n,
      btts: yesNo.btts[0] / n, o25: yesNo.o25[0] / n, o15: yesNo.o15[0] / n,
      cal: Object.keys(cal).sort((a, b) => a - b).map(k => ({ from: k / 10, to: (+k + 1) / 10, n: cal[k].n, pred: cal[k].p / cal[k].n, hit: cal[k].hit / cal[k].n })),
      cats: Object.keys(thr).map(k => ({ name: k, pred: thr[k].pSum / thr[k].all[1], hit: thr[k].all[0] / thr[k].all[1], hiN: thr[k].hi[1], hiHit: thr[k].hi[1] ? thr[k].hi[0] / thr[k].hi[1] : null })),
      last: preds.slice(-12).reverse().map(p => ({ hn: p.f.hn, an: p.f.an, hg: p.f.hg, ag: p.f.ag, ts: p.f.ts, home: p.mk.home, draw: p.mk.draw, away: p.mk.away, top: p.mk.topScores[0], btts: p.mk.bttsYes, o25: p.mk.over[2.5] }))
    };
  }

    // Izgara araması: birden çok sezonda ortalama Brier skorunu en düşük yapan ayarlar
  // İki aşamalı ızgara araması (ortalama Brier skoru en düşük olan):
  // 1) çekme payı / ağırlık / sınır, 2) güç farkı açma (stretch)
  async function tune(seasons, onProgress) {
    const evalP = p => { let b = 0, hit = 0; seasons.forEach(fx => { const r = backtest(fx, 40, p, 30); b += r.brier; hit += r.favHit; }); return { par: p, brier: b / seasons.length, favHit: hit / seasons.length }; };
    const g1 = [];
    [1, 2, 4, 8].forEach(prior => [60, 120, 100000].forEach(halfLife => [4, 6].forEach(cap => g1.push({ prior, halfLife, cap, stretch: 1 }))));
    const stretches = [1.1, 1.2, 1.3, 1.4, 1.5, 1.65];
    const total = g1.length + 4 * stretches.length;
    let best = null, step = 0;
    for (const p of g1) { const c = evalP(p); if (!best || c.brier < best.brier) best = c; if (onProgress) await onProgress(++step, total); }
    const base = best.par;
    for (const prior of [1, 2, 4, 8]) for (const k of stretches) {
      const c = evalP(Object.assign({}, base, { prior, stretch: k })); if (c.brier < best.brier) best = c; if (onProgress) await onProgress(++step, total);
    }
    return best;
  }

  root.Model = { fitRatings, predict, matrix, markets, pois, xgFactor, backtest, tune, setParams, getParams: () => Object.assign({}, PAR), DEF };
  if (typeof module !== 'undefined') module.exports = root.Model;
})(typeof window !== 'undefined' ? window : globalThis);
