import {
  type ContextualHelpContent,
  type HelpField,
  type HelpSection,
} from "@/lib/contextual-help";

/**
 * Presentational help renderers, extracted VERBATIM from the retired
 * `contextual-help-button.tsx` (epic #2094 C2). Already token-pure — every
 * colour is a role/semantic token that resolves in both `.app-theme-scope` and
 * `.website-theme` — so it is reused unchanged by the help widget's browse
 * ("Page guide") view. No `"use client"`: these are pure render functions with
 * no hooks, so they compose into a server or client tree freely.
 */

export function HelpList({ title, items }: { title: string; items: string[] }) {
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

export function FieldHelpList({ fields }: { fields: HelpField[] }) {
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

export function SectionHelpList({
  title = "Complex sections",
  sections,
}: {
  title?: string;
  sections: HelpSection[];
}) {
  if (sections.length === 0) {
    return null;
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
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

export function HelpContentBody({ help }: { help: ContextualHelpContent }) {
  return (
    <div className="space-y-5">
      <HelpList title="Common actions" items={help.actions} />
      <FieldHelpList fields={help.fields ?? []} />
      <SectionHelpList sections={help.sections ?? []} />
      <HelpList title="Important notes" items={help.notes ?? []} />
    </div>
  );
}
