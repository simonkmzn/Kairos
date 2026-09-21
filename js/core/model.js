/*
 * L2-regularized logistic regression fitted by Newton / IRLS.
 * Predicts P(price is higher H candles from now).
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});
  const CLIP = 5;

  function cholSolve(A, b, P) {
    const L = new Float64Array(P * P);
    for (let i = 0; i < P; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i * P + j];
        for (let k = 0; k < j; k++) s -= L[i * P + k] * L[j * P + k];
        if (i === j) L[i * P + i] = Math.sqrt(Math.max(s, 1e-12));
        else L[i * P + j] = s / L[j * P + j];
      }
    }
    const y = new Float64Array(P);
    for (let i = 0; i < P; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) s -= L[i * P + k] * y[k];
      y[i] = s / L[i * P + i];
    }
    const x = new Float64Array(P);
    for (let i = P - 1; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k < P; k++) s -= L[k * P + i] * x[k];
      x[i] = s / L[i * P + i];
    }
    return x;
  }

  // Z: Float64Array N x P with column 0 = 1 (intercept, not penalized).
  function fit(Z, y, N, P, lambda, init, maxIter) {
    const beta = init ? Float64Array.from(init) : new Float64Array(P);
    const H = new Float64Array(P * P), g = new Float64Array(P);
    for (let it = 0; it < maxIter; it++) {
      H.fill(0);
      g.fill(0);
      for (let r = 0; r < N; r++) {
        const base = r * P;
        let eta = 0;
        for (let a = 0; a < P; a++) eta += beta[a] * Z[base + a];
        const p = 1 / (1 + Math.exp(-eta));
        const w = p * (1 - p) + 1e-9;
        const e = y[r] - p;
        for (let a = 0; a < P; a++) {
          const za = Z[base + a];
          g[a] += za * e;
          const wa = w * za, rowA = a * P;
          for (let b = a; b < P; b++) H[rowA + b] += wa * Z[base + b];
        }
      }
      for (let a = 1; a < P; a++) {
        H[a * P + a] += lambda;
        g[a] -= lambda * beta[a];
      }
      for (let a = 0; a < P; a++) for (let b = 0; b < a; b++) H[a * P + b] = H[b * P + a];
      const d = cholSolve(H, g, P);
      let mx = 0;
      for (let a = 0; a < P; a++) {
        beta[a] += d[a];
        mx = Math.max(mx, Math.abs(d[a]));
      }
      if (mx < 1e-5) break;
    }
    return beta;
  }

  // Probability for one raw feature row (Float32Array/Array of length D, offset `off`).
  function predictRow(model, X, off) {
    const { beta, mean, std } = model;
    let eta = beta[0];
    for (let k = 0; k < mean.length; k++) {
      let z = (X[off + k] - mean[k]) / std[k];
      z = z > CLIP ? CLIP : z < -CLIP ? -CLIP : z;
      eta += beta[k + 1] * z;
    }
    return 1 / (1 + Math.exp(-eta));
  }

  // Per-feature contribution to the log-odds, for explaining a prediction.
  function explainRow(model, X, off) {
    const { beta, mean, std } = model;
    const out = [];
    for (let k = 0; k < mean.length; k++) {
      let z = (X[off + k] - mean[k]) / std[k];
      z = z > CLIP ? CLIP : z < -CLIP ? -CLIP : z;
      out.push({ index: k, z, contribution: beta[k + 1] * z });
    }
    return { intercept: beta[0], features: out };
  }

  K.model = { CLIP, fit, predictRow, explainRow };
})(typeof self !== 'undefined' ? self : this);
