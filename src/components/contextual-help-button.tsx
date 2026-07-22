"use client";

import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getContextualHelp,
  type ContextualHelpContent,
  type HelpField,
  type HelpScope,
  type HelpSection,
} from "@/lib/contextual-help";

function HelpList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function FieldHelpList({ fields }: { fields: HelpField[] }) {
  if (fields.length === 0) {
    return null;
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">Key fields</h3>
      <dl className="space-y-2 text-sm leading-6">
        {fields.map((field) => (
          <div
            key={field.name}
            className="rounded-md border border-border bg-card px-3 py-2"
          >
            <dt className="font-medium text-foreground">{field.name}</dt>
            <dd className="text-muted-foreground">{field.description}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SectionHelpList({ sections }: { sections: HelpSection[] }) {
  if (sections.length === 0) {
    return null;
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">
        Complex sections
      </h3>
      <div className="space-y-3">
        {sections.map((section) => (
          <div key={section.title} className="space-y-1">
            <h4 className="text-sm font-medium text-foreground">
              {section.title}
            </h4>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
              {section.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function HelpDialogContent({ help }: { help: ContextualHelpContent }) {
  return (
    <div className="space-y-5">
      <HelpList title="Common actions" items={help.actions} />
      <FieldHelpList fields={help.fields ?? []} />
      <SectionHelpList sections={help.sections ?? []} />
      <HelpList title="Important notes" items={help.notes ?? []} />
    </div>
  );
}

export function ContextualHelpButton({ scope }: { scope: HelpScope }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const help = getContextualHelp(pathname, scope);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label={`Open ${help.title} help`}
        title={`${help.title} help`}
        className="shrink-0 print:hidden"
      >
        <CircleHelp className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{help.title} help</DialogTitle>
            <DialogDescription>{help.summary}</DialogDescription>
          </DialogHeader>
          <HelpDialogContent help={help} />
        </DialogContent>
      </Dialog>
    </>
  );
}
