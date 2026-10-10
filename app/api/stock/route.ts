import { NextRequest, NextResponse } from "next/server";
import { fetchStock, RANGES, type StockRange } from "@/lib/stocks";

/** GET /api/stock?symbol=AAPL&range=1mo — used by the stock panel to switch ranges and to refresh while the market is open. */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  const range = (req.nextUrl.searchParams.get("range") ?? "1d") as StockRange;
  if (!RANGES.includes(range)) return NextResponse.json({ error: "Bad range" }, { status: 400 });
  const stock = await fetchStock(symbol, range);
  return stock ? NextResponse.json(stock) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
