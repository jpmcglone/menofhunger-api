export type CashtagResultDto = {
  /** Uppercase ticker symbol (no '$'), e.g. "SPY". */
  symbol: string;
  /** Full company or ETF name, e.g. "SPDR S&P 500 ETF Trust". */
  name: string;
};
