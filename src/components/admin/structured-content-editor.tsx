"use client";

import { useState } from "react";
import { ImageIcon, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ImagePickerDialog } from "@/components/admin/image-picker-dialog";
import type {
  PageContentSchema,
  RowsFieldSpec,
  ScalarFieldSpec,
  StructuredContentValues,
  StructuredRow,
} from "@/lib/page-content-schema";

/**
 * Plain-text editor for a design page's structured content. Renders the page
 * schema as labelled single-line inputs, multi-line textareas, and add/remove
 * row tables. No contenteditable, no HTML toolbar: the layout and styling are
 * locked in the page's code, only the words are editable here.
 */
export function StructuredContentEditor({
  schema,
  values,
  onChange,
}: {
  schema: PageContentSchema;
  values: StructuredContentValues;
  onChange: (next: StructuredContentValues) => void;
}) {
  function setScalar(key: string, next: string) {
    onChange({ ...values, [key]: next });
  }

  function setRows(key: string, rows: StructuredRow[]) {
    onChange({ ...values, [key]: rows });
  }

  function getRows(field: RowsFieldSpec): StructuredRow[] {
    const raw = values[field.key];
    return Array.isArray(raw) ? raw : field.default;
  }

  function blankRow(field: RowsFieldSpec): StructuredRow {
    const row: StructuredRow = {};
    for (const column of field.columns) {
      row[column.key] = "";
    }
    return row;
  }

  return (
    <div className="flex flex-col gap-6">
      {schema.sections.map((section) => (
        <section
          key={section.title}
          className="space-y-4 rounded-md border border-slate-200 bg-white p-4"
        >
          <div>
            <h3 className="text-sm font-semibold text-slate-800">
              {section.title}
            </h3>
            {section.description ? (
              <p className="mt-1 text-xs text-slate-500">
                {section.description}
              </p>
            ) : null}
          </div>

          <div className="space-y-4">
            {section.fields.map((field) =>
              field.kind === "scalar" ? (
                <ScalarField
                  key={field.key}
                  field={field}
                  value={
                    typeof values[field.key] === "string"
                      ? (values[field.key] as string)
                      : ""
                  }
                  onChange={(next) => setScalar(field.key, next)}
                />
              ) : (
                <RowsField
                  key={field.key}
                  field={field}
                  rows={getRows(field)}
                  onAdd={() =>
                    setRows(field.key, [...getRows(field), blankRow(field)])
                  }
                  onRemove={(index) =>
                    setRows(
                      field.key,
                      getRows(field).filter((_, i) => i !== index),
                    )
                  }
                  onCellChange={(index, columnKey, next) =>
                    setRows(
                      field.key,
                      getRows(field).map((row, i) =>
                        i === index ? { ...row, [columnKey]: next } : row,
                      ),
                    )
                  }
                />
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function ScalarField({
  field,
  value,
  onChange,
}: {
  field: ScalarFieldSpec;
  value: string;
  onChange: (next: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="block space-y-1">
      <span className="text-xs font-medium text-slate-700">{field.label}</span>
      {field.type === "multiline" ? (
        <Textarea
          value={value}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-24"
        />
      ) : field.type === "select" ? (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === "image" ? (
        <div className="space-y-2">
          {value ? (
            <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={value}
                alt="Selected"
                className="h-14 w-20 shrink-0 rounded border border-slate-200 object-cover"
              />
              <p className="min-w-0 flex-1 truncate text-xs text-slate-600">
                {value}
              </p>
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500">
              No image chosen — the default is used.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setPickerOpen(true)}
            >
              <ImageIcon className="h-3.5 w-3.5" />
              {value ? "Change image" : "Choose image"}
            </Button>
            {value ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onChange("")}
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </Button>
            ) : null}
          </div>
          <ImagePickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onSelect={(url) => onChange(url)}
          />
        </div>
      ) : (
        <Input
          value={value}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.help ? (
        <span className="block text-xs text-slate-500">{field.help}</span>
      ) : null}
    </div>
  );
}

function RowsField({
  field,
  rows,
  onAdd,
  onRemove,
  onCellChange,
}: {
  field: RowsFieldSpec;
  rows: StructuredRow[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onCellChange: (index: number, columnKey: string, next: string) => void;
}) {
  const atMax = rows.length >= field.maxRows;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-700">
          {field.label}
        </span>
        <span className="text-xs text-slate-400">
          {rows.length} / {field.maxRows}
        </span>
      </div>
      {field.help ? (
        <p className="text-xs text-slate-500">{field.help}</p>
      ) : null}

      <div className="space-y-3">
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500">
            No rows yet. Add one to start.
          </p>
        ) : (
          rows.map((row, index) => (
            <div
              key={index}
              className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500">
                  Row {index + 1}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  aria-label={`Remove row ${index + 1}`}
                  onClick={() => onRemove(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {field.columns.map((column) => (
                  <label key={column.key} className="block space-y-1">
                    <span className="text-xs font-medium text-slate-700">
                      {column.label}
                    </span>
                    {column.type === "multiline" ? (
                      <Textarea
                        value={row[column.key] ?? ""}
                        maxLength={column.maxLength}
                        onChange={(event) =>
                          onCellChange(index, column.key, event.target.value)
                        }
                        className="min-h-20"
                      />
                    ) : (
                      <Input
                        value={row[column.key] ?? ""}
                        maxLength={column.maxLength}
                        onChange={(event) =>
                          onCellChange(index, column.key, event.target.value)
                        }
                      />
                    )}
                  </label>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAdd}
        disabled={atMax}
      >
        <Plus className="h-4 w-4" />
        Add row
      </Button>
    </div>
  );
}
