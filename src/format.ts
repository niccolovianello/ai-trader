const money = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const usd = (n: number) => `${money.format(n).replace("-", "−")} $`;
export const percent = (ratio: number) => `${pct.format(ratio * 100).replace("-", "−")}%`;
