# Privacy policy: TCG Order Printer

_Last updated: 2026-10-02_

TCG Order Printer prints TCGplayer packing slips and address labels on your own printer. It is designed so your order data never leaves your computer.

## What the extension accesses

- **TCGplayer Seller Portal pages** (`sellerportal.tcgplayer.com`): it reads the order number shown on the page and adds a **Print both** button. When you click it, the extension captures the packing-slip PDF that TCGplayer's own **Print Default** export generates.
- **The packing-slip PDF**: it contains the buyer's name and shipping address. The extension passes it only to the local print helper on your computer, over Chrome native messaging.
- **Downloads** (`downloads` permission): used only to detect when a packing slip was saved to disk instead of captured, so it can tell you nothing was printed. It does not read your download history beyond that event.
- **Local storage**: the result of your most recent print (order number, status, time), shown in the toolbar popup.

## What it does not do

- It sends no data to the developer or to any third party. There are no analytics, ads, trackers or remote code.
- It makes no network requests of its own.
- It does not sell, share or transfer user data, and it does not use data for any purpose other than printing your slips and labels.

## The local print helper

The optional [helper](https://github.com/LLRHook/tcg-order-printer-helper) runs on your Mac. It stores slips and generated labels in `~/Library/Application Support/TCGOrderPrinter` with owner-only permissions and deletes them after 7 days. It makes no network requests.

## Contact

Questions or concerns: [open an issue](https://github.com/LLRHook/tcg-order-printer/issues).
