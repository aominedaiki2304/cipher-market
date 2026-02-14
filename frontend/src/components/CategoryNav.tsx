import { TrendingUp } from "lucide-react";

interface CategoryNavProps {
  active?: string;
  categories?: string[];
  onSelect?: (name: string) => void;
}

const CategoryNav = ({ active = "All", categories = ["All"], onSelect }: CategoryNavProps) => {
  return (
    <nav className="border-b border-border bg-background">
      <div className="mx-auto max-w-[1400px] px-4">
        <div className="scrollbar-hide flex gap-1 overflow-x-auto py-2">
          {categories.map((name) => (
            <button
              key={name}
              onClick={() => onSelect?.(name)}
              className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active === name
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              {name === "All" ? <TrendingUp size={14} /> : null}
              {name}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
};

export default CategoryNav;
