import { ChevronDown } from 'lucide-react';

const filters = ['All', 'Active', 'Hide sports', 'Hide crypto', 'Hide earnings'];

const FilterRow = () => {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-3">
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
        <button className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted transition-colors">
          24hr Volume
          <ChevronDown size={14} className="text-muted-foreground" />
        </button>
        <div className="h-5 w-px bg-border" />
        {filters.map((f, i) => (
          <button
            key={f}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              i === 0
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            {f}
          </button>
        ))}
      </div>
    </div>
  );
};

export default FilterRow;
