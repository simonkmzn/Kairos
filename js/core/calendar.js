/*
 * Scheduled macro events with known dates: FOMC rate decisions (statement at
 * 14:00 US Eastern on the meeting's last day; 18:30 UTC is close enough for a
 * signal that ramps over 48 hours). Includes the 2020 emergency cuts.
 */
(function (root) {
  'use strict';
  const K = (root.KAIROS = root.KAIROS || {});
  const FOMC_DAYS = [
    '2019-01-30', '2019-03-20', '2019-05-01', '2019-06-19', '2019-07-31', '2019-09-18', '2019-10-30', '2019-12-11',
    '2020-01-29', '2020-03-03', '2020-03-15', '2020-04-29', '2020-06-10', '2020-07-29', '2020-09-16', '2020-11-05', '2020-12-16',
    '2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16', '2021-07-28', '2021-09-22', '2021-11-03', '2021-12-15',
    '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
    '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
    '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
    '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
    '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  ];
  const FOMC = FOMC_DAYS.map((d) => Date.parse(d + 'T18:30:00Z'));

  // Milliseconds until the next FOMC decision at or after t (Infinity past the list).
  function untilFomc(t) {
    let lo = 0, hi = FOMC.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (FOMC[m] < t) lo = m + 1; else hi = m;
    }
    return lo < FOMC.length ? FOMC[lo] - t : Infinity;
  }
  // 0 far from a decision, rising linearly to 1 at the decision over `hours`.
  function fomcAhead(t, hours) {
    const h = untilFomc(t) / 3600000;
    return h <= hours ? 1 - h / hours : 0;
  }

  K.calendar = { FOMC, untilFomc, fomcAhead };
})(typeof self !== 'undefined' ? self : this);
