# CipherMarket CTX Frontend Plan (Aligned to Current Codebase)

## Purpose
This document reflects what is currently implemented in `/Users/aomine/Desktop/encryted agent/frontend`, plus the remaining polish items if we want to push closer to strict Polymarket parity.

## Scope
- Frontend only.
- Static mock data.
- No backend, wallet, or blockchain execution logic.

## Current Implementation Status

### Routing
- Implemented:
  - `/` via `src/pages/Index.tsx`
  - `/market/:id` via `src/pages/MarketDetail.tsx`
  - `404` via `src/pages/NotFound.tsx`
- Router config: `src/App.tsx`

### Screen 1: Market Board (`/`)
- Implemented in:
  - `src/pages/Index.tsx`
  - `src/components/Header.tsx`
  - `src/components/CategoryNav.tsx`
  - `src/components/TopicPills.tsx`
  - `src/components/FilterRow.tsx`
  - `src/components/MarketCard.tsx`
- Includes:
  - Header with logo, search input, `How it works`, `Log In`, `Sign Up`
  - Category row and topic pill row
  - Filter row (`24hr Volume`, `All`, `Active`, `Hide sports`, `Hide crypto`, `Hide earnings`)
  - Responsive market grid (1/2/3/4 columns based on breakpoints)

### Screen 2: Market Detail (`/market/:id`)
- Implemented in:
  - `src/pages/MarketDetail.tsx`
  - `src/components/ChartPlaceholder.tsx`
- Includes:
  - Date pills (`Past`, `Mar 18`, `Apr 29`, `Jun 17`)
  - Market header with breadcrumb and share/bookmark actions
  - Chart placeholder with Y-axis and time-range pills
  - Volume/date stats
  - Outcome rows with percentage, change indicator, buy action buttons
  - Rules section with `Show more`
  - Comments header (`Top Holders`, `Activity`)

### Screen 3: Trade Ticket (Right Sidebar)
- Implemented in `src/components/TradeTicket.tsx`
- Includes:
  - Outcome selector
  - Buy/Sell tabs
  - Market dropdown affordance
  - Yes/No selection buttons with cent pricing
  - Amount input and quick chips (`+$1`, `+$20`, `+$100`, `Max`)
  - Primary CTA
  - Terms text

### Screen 4: Order Book
- Implemented in `src/components/OrderBook.tsx`
- Includes:
  - Expand/collapse behavior
  - Asks and bids rendering
  - Depth bars
  - Price/Shares/Total columns
  - Spread indicator

### Screen 5: Receipts
- Implemented in `src/components/Receipts.tsx`
- Includes:
  - Recent trade rows
  - Status badges (`Filled`, `Pending`, `Cancelled`)
  - Empty state handling when list is empty

### Screen 6: Related Markets
- Implemented in `src/components/RelatedMarkets.tsx`
- Includes:
  - `all` / `derivatives` tabs
  - Compact related market links with probability

### Visual States
- Implemented in `src/components/VisualStates.tsx`
  - `LoadingCards`
  - `EmptyState`
  - `ErrorState`

### Mock Data
- Implemented in `src/data/mockData.ts`
- Currently includes:
  - Categories and topic pills
  - ~12 demo markets
  - Order book bids/asks
  - Receipts list
  - Related markets list

## Design System (Current)
- Theme currently uses dark-oriented tokens in `src/index.css`.
- Tailwind tokens wired in `tailwind.config.ts`.
- Typography uses Inter.
- Yes/No semantic colors provided via custom `cm-*` variables.

## Gaps vs Strict Polymarket-Faithful Light Theme
- Theme is currently dark, while strict light-mode parity is not yet applied.
- `Rules / Market Context` tab pair is not fully implemented as two distinct content tabs.
- No sticky bottom mobile trade CTA bar yet.
- Header hamburger is mobile-only.

## Next-Step Work Items
1. Switch root design tokens to light-mode parity while preserving component structure.
2. Reduce market demo set to 3-5 markets for focused demo mode.
3. Add explicit `Rules` and `Market Context` tabbed section on detail page.
4. Add mobile sticky bottom trade CTA pattern.
5. Tighten spacing/typography tokens to closer screenshot parity.

## Run Instructions
```bash
cd /Users/aomine/Desktop/encryted\ agent/frontend
npm install
npm run dev
```

