import { useEffect, useState } from "react";
import { Check, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getCachedMarketUrl, prefetchMarketUrls, copyTextSync } from "@/lib/polymarket";

export const CopyLinkButton = ({ assetId }: { assetId: string }) => {
  const [url, setUrl] = useState<string | null>(() => getCachedMarketUrl(assetId));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (url) return;
    let alive = true;
    prefetchMarketUrls([assetId]).then(() => {
      if (alive) setUrl(getCachedMarketUrl(assetId));
    });
    return () => {
      alive = false;
    };
  }, [assetId, url]);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const u = url ?? `https://polymarket.com/markets?q=${assetId}`;
    const ok = copyTextSync(u);
    if (ok) {
      setCopied(true);
      toast.success("Polymarket link copied", { description: u });
      setTimeout(() => setCopied(false), 1500);
    } else {
      // Last-resort: prompt so the user can copy manually.
      window.prompt("Copy this Polymarket link:", u);
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={onClick}
      title={url ?? "Copy Polymarket link"}
      className="h-7 px-2 text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <LinkIcon className="h-3 w-3" />}
    </Button>
  );
};
