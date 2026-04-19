import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { copyTextSync } from "@/lib/polymarket";

type Props = {
  /** Text to copy (e.g. the market question / trade name). */
  text: string | null | undefined;
  /** Kept for backwards compat with existing call sites; unused. */
  assetId?: string;
};

export const CopyLinkButton = ({ text }: Props) => {
  const [copied, setCopied] = useState(false);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const value = (text ?? "").trim();
    if (!value) {
      toast.error("Nothing to copy");
      return;
    }
    const ok = copyTextSync(value);
    if (ok) {
      setCopied(true);
      toast.success("Copied", { description: value });
      setTimeout(() => setCopied(false), 1500);
    } else {
      window.prompt("Copy:", value);
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={onClick}
      title={text ? `Copy "${text}"` : "Copy"}
      className="h-7 px-2 text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
};
