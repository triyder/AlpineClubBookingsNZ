"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface BookingMessageOverride {
  bodyText: string;
  updatedAt: string;
  updatedByMemberId: string | null;
}

interface BookingMessageDefinition {
  key: string;
  section: string;
  label: string;
  description: string;
  defaultBody: string;
  bodyText: string;
  tokens: string[];
  override: BookingMessageOverride | null;
}

export function BookingMessagesPanel() {
  const [messages, setMessages] = useState<BookingMessageDefinition[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const currentMessage = useMemo(
    () => messages.find((message) => message.key === selectedKey) ?? null,
    [messages, selectedKey],
  );

  async function load(nextSelectedKey = selectedKey) {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/booking-messages", {
        credentials: "same-origin",
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(responseBody?.error ?? "Failed to load booking messages");
      }
      const nextMessages = responseBody.messages as BookingMessageDefinition[];
      const key = nextSelectedKey || nextMessages[0]?.key || "";
      const selected = nextMessages.find((message) => message.key === key);
      setMessages(nextMessages);
      setSelectedKey(key);
      setBodyText(selected?.bodyText ?? "");
      setPreviewText("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load booking messages");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectMessage(key: string) {
    const selected = messages.find((message) => message.key === key);
    setSelectedKey(key);
    setBodyText(selected?.bodyText ?? "");
    setPreviewText("");
  }

  async function saveMessage() {
    if (!currentMessage) return;
    setSaving(true);
    try {
      const response = await fetch("/api/admin/booking-messages", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageKey: currentMessage.key,
          bodyText,
        }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          responseBody?.issues?.join(" ") ??
            responseBody?.error ??
            "Failed to save booking message",
        );
      }
      toast.success("Booking message saved");
      await load(currentMessage.key);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save booking message");
    } finally {
      setSaving(false);
    }
  }

  async function resetMessage() {
    if (!currentMessage) return;
    setSaving(true);
    try {
      const response = await fetch("/api/admin/booking-messages/reset", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageKey: currentMessage.key }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(responseBody?.error ?? "Failed to restore default");
      }
      setBodyText(currentMessage.defaultBody);
      setPreviewText("");
      toast.success("Default restored");
      await load(currentMessage.key);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to restore default");
    } finally {
      setSaving(false);
    }
  }

  async function previewMessage() {
    if (!currentMessage) return;
    try {
      const response = await fetch("/api/admin/booking-messages/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageKey: currentMessage.key,
          bodyText,
        }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          responseBody?.issues?.join(" ") ??
            responseBody?.error ??
            "Failed to preview booking message",
        );
      }
      setPreviewText(responseBody.rendered ?? "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to preview booking message");
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading booking messages</p>;
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div>
          <Label htmlFor="booking-message-select">Template</Label>
          <Select value={selectedKey} onValueChange={selectMessage}>
            <SelectTrigger id="booking-message-select" className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {messages.map((message) => (
                <SelectItem key={message.key} value={message.key}>
                  {message.section}: {message.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {currentMessage ? (
          <div className="space-y-2 text-sm text-slate-600">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{currentMessage.section}</Badge>
              <Badge variant="outline">{currentMessage.key}</Badge>
              {currentMessage.override ? <Badge>Custom</Badge> : null}
            </div>
            <p>{currentMessage.description}</p>
          </div>
        ) : null}
      </div>

      {currentMessage ? (
        <div className="space-y-2">
          <Label>Merge fields</Label>
          <div className="flex flex-wrap gap-2">
            {currentMessage.tokens.map((token) => (
              <Badge key={token} variant="outline">{`{{${token}}}`}</Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <Label htmlFor="booking-message-body">Message</Label>
        <Textarea
          id="booking-message-body"
          className="mt-1 min-h-72 font-mono text-sm"
          value={bodyText}
          onChange={(event) => setBodyText(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={saveMessage} disabled={saving || !currentMessage}>
          <Save className="h-4 w-4" />
          {saving ? "Saving" : "Save Message"}
        </Button>
        <Button variant="outline" onClick={previewMessage} disabled={!currentMessage}>
          <Eye className="h-4 w-4" />
          Preview
        </Button>
        <Button variant="outline" onClick={resetMessage} disabled={saving || !currentMessage}>
          <RotateCcw className="h-4 w-4" />
          Restore Default
        </Button>
      </div>

      {previewText ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <p className="whitespace-pre-wrap text-sm text-slate-900">{previewText}</p>
        </div>
      ) : null}
    </div>
  );
}
