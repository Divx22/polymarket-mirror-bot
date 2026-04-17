export const fmtUsd = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

export const fmtNum = (n: number | null | undefined, dp = 4) => {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: dp,
  });
};

export const fmtPrice = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(3);
};

export const fmtTime = (ts: number | string | null | undefined) => {
  if (!ts) return "—";
  const ms = typeof ts === "number" ? ts * 1000 : Number(ts) * 1000;
  return new Date(ms).toLocaleString();
};

export const fmtRelative = (ts: number | string | null | undefined) => {
  if (!ts) return "—";
  const ms = typeof ts === "number" ? ts * 1000 : Number(ts) * 1000;
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

export const shortHash = (h: string | null | undefined) => {
  if (!h) return "—";
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
};

export const shortAddr = (a: string | null | undefined) => {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
};
