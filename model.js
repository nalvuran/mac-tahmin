// Maç Tahmin - model (Poisson + Dixon-Coles). Tarayıcıda window.Model, Node'da module.exports.
(function (root) {
  const CAP = 4;          // tek maçlık uç skorları sınırla (8-0 -> 4-0)
  const HALF_LIFE = 90;   // gün; yeni maçlar daha ağır
  const PRIOR_GAMES = 4;  // küçük örneklem için lig ortalamasına çekme
  const RHO = -0.08;      // Dixon-Coles düşük skor düzeltmesi
  const MAXG = 8;

  // fixtures: [{home, away, hg, ag, ts}] (ts: saniye)
  function fitRatings(fixtures, nowTs) {
    nowTs = nowTs || Date.now() / 1000;
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
    for (let it = 0; it < 60; it++) {
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
    let aH = R.att[homeId] || 1, dH = R.def[homeId] || 1, aA = R.att[awayId] || 1, dA = R.def[awayId] || 1;
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

  root.Model = { fitRatings, predict, matrix, markets, pois, xgFactor };
  if (typeof module !== 'undefined') module.exports = root.Model;
})(typeof window !== 'undefined' ? window : globalThis);
