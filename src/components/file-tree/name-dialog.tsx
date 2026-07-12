import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface NameDialogProps {
  open: boolean;
  title: string;
  initialValue?: string;
  confirmLabel: string;
  onConfirm: (name: string) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
}

export function NameDialog({
  open,
  title,
  initialValue = "",
  confirmLabel,
  onConfirm,
  onOpenChange,
}: NameDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const submit = async () => {
    const name = value.trim();
    if (!name || name.includes("/")) return;
    setBusy(true);
    try {
      const ok = await onConfirm(name);
      if (ok) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
