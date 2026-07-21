"use client";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  tokensForContext,
  type HtmlTokenDefinition,
  type TokenContextId,
} from "@/lib/token-catalogue";
import { parseTokenParameters } from "@/lib/token-parameters";

// Surface the recognised parameter keys from a token's example so editors see
// the grammar (comma-separated key=value) the renderer actually parses (#1933).
// This shares the single client-safe parser with the public renderer.
function parameterKeysFromExample(example: string | undefined): string[] {
  if (!example) return [];
  const match = example.match(/\{\{[^:{}]+:([^{}]+)\}\}/);
  return [...parseTokenParameters(match?.[1]).params.keys()];
}

export type TokenChip = {
  token: string;
  /** Required tokens render with the default (filled) badge variant. */
  required?: boolean;
};

/**
 * Shared badge-row renderer for token lists. Used by the page-content,
 * email-message, and booking-message panels so token chips look the same
 * everywhere, regardless of which catalogue supplies the names.
 */
export function TokenChips({ tokens }: { tokens: TokenChip[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {tokens.map(({ token, required }) => (
        <Badge
          key={token}
          variant={required ? "default" : "outline"}
          className="font-mono text-[11px]"
        >
          {`{{${token}}}`}
        </Badge>
      ))}
    </div>
  );
}

function TokenEntry({ definition }: { definition: HtmlTokenDefinition }) {
  const parameterKeys = parameterKeysFromExample(definition.parameterExample);
  return (
    <div>
      <p>
        <i>
          <b>{definition.token}</b>
        </i>
      </p>
      <p>{definition.description}</p>
      <p>
        Example: <code>{definition.example}</code>
      </p>
      {definition.parameterExample ? (
        <p>
          With a parameter: <code>{definition.parameterExample}</code>
        </p>
      ) : null}
      {parameterKeys.length > 0 ? (
        <p>Parameter keys: {parameterKeys.join(", ")}</p>
      ) : null}
      {definition.notes ? <p>{definition.notes}</p> : null}
      {definition.kind === "embed" && !definition.allowsLegacySingleBrace ? (
        <p>
          Double braces only; the single-brace {`{${definition.token}}`} form
          is not supported.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Catalogue-driven token documentation for one editor context, grouped into
 * embed and text sections. Rendered inside TokenHelpDialog and reused by the
 * Page Content help dialog so both stay in lockstep with the catalogue.
 */
export function TokenCatalogueSections({
  context,
}: {
  context: TokenContextId;
}) {
  const tokens = tokensForContext(context);
  const embedTokens = tokens.filter((token) => token.kind === "embed");
  const textTokens = tokens.filter((token) => token.kind === "text");
  const hasLegacyTokens = tokens.some(
    (token) => token.allowsLegacySingleBrace,
  );

  return (
    <div className="space-y-3 text-sm leading-6 text-muted-foreground">
      <p>
        Add a token by typing its name in double braces, for example{" "}
        <code>{tokens[0]?.example}</code>.
        {hasLegacyTokens
          ? " Legacy single-brace {token} syntax remains accepted except where noted."
          : ""}
      </p>
      {embedTokens.length > 0 ? (
        <>
          <p className="font-semibold text-foreground">Embed tokens</p>
          <p>
            Each embed token is replaced with a live component when the page
            renders.
          </p>
          {embedTokens.map((definition) => (
            <TokenEntry key={definition.token} definition={definition} />
          ))}
        </>
      ) : null}
      {textTokens.length > 0 ? (
        <>
          <p className="font-semibold text-foreground">Text tokens</p>
          <p>
            Text tokens are replaced inline with the current value when the
            content is shown to readers.
          </p>
          {textTokens.map((definition) => (
            <TokenEntry key={definition.token} definition={definition} />
          ))}
        </>
      ) : null}
    </div>
  );
}

/**
 * Token help dialog opened from the WysiwygEditor toolbar. Lists every token
 * available in the editor's context, straight from the shared catalogue.
 */
export function TokenHelpDialog({
  context,
  open,
  onOpenChange,
}: {
  context: TokenContextId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Token help</DialogTitle>
          <DialogDescription>
            Tokens you can use in this editor. They are replaced with live
            content when readers view the page.
          </DialogDescription>
        </DialogHeader>
        <TokenCatalogueSections context={context} />
      </DialogContent>
    </Dialog>
  );
}
