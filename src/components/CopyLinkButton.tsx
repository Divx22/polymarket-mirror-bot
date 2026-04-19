import { useState } from "react";
import { Check, Link as LinkIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { copyMarketLink } from "@/lib/polymarket";

export const CopyLinkButton = ({ assetId, label }: { assetId: string; label?: string }) => {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setState("loading");
    try {
      const url = await copyMarketLink(assetId);
      setState("done");
      toast.success("Polymarket link copied", { description: url });
      setTimeout(() => setState("idle"), 1500);
    } catch (err: any) {
      setState("idle");
      toast.error(err?.message ?? "Copy failed");
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={onClick}
      title="Copy Polymarket link"
      className="h-7 px-2 text-muted-foreground hover:text-foreground"
    >
      {state === "loading" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : state === "done" ? (
        <Check className="h-3 w-3" />
      ) : (
        <LinkIcon className="h-3 w-3" />
      )}
      {label && <span className="ml-1 text-[10px]">{label}</span>}
    </Button>
  );
};
