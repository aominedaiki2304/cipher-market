import EvidencePanel from "@/components/EvidencePanel";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

const EvidenceSheet = () => {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className="h-9 rounded-full border border-border px-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
        >
          API
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>System Evidence</SheetTitle>
          <SheetDescription>Health checks and trace export for verifiable BITE v2 evidence.</SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          <EvidencePanel embedded />
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default EvidenceSheet;

