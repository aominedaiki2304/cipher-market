import { Search, SlidersHorizontal, Bookmark } from "lucide-react";

interface TopicPillsProps {
  active?: string;
  topics?: string[];
  onSelect?: (topic: string) => void;
}

const TopicPills = ({ active = "All", topics = ["All"], onSelect }: TopicPillsProps) => {
  return (
    <div className="border-b border-border bg-background">
      <div className="mx-auto flex max-w-[1400px] items-center gap-2 px-4 py-2">
        <div className="scrollbar-hide flex flex-1 gap-2 overflow-x-auto">
          {topics.map((topic) => (
            <button
              key={topic}
              onClick={() => onSelect?.(topic)}
              className={`shrink-0 rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                active === topic
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              }`}
            >
              {topic}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-l border-border pl-2">
          <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted">
            <Search size={16} />
          </button>
          <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted">
            <SlidersHorizontal size={16} />
          </button>
          <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted">
            <Bookmark size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default TopicPills;
