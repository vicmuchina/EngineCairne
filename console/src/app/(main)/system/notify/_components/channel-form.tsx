"use client";

import { CheckIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { NotificationFilter } from "@/lib/types";

// asText / inputType are value helpers local to this file (tightly tied to rendering the controls), so they do not live in channel-fields.
import { type FieldDef, type FieldKind, SEVERITY_OPTIONS } from "./channel-fields";

// asText renders any configuration value into a string an input box can use.
// config comes from JSON, so a value may be a string / number / boolean / array / null, and
// all that matters here is "can it go into a text box"; the actual serialization is buildConfig's job.
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

// inputType maps a field type onto the input's type attribute.
function inputType(kind: FieldKind): "text" | "password" | "number" {
  if (kind === "password") return "password";
  if (kind === "number") return "number";
  return "text";
}

// ConfigField renders the matching control for a field definition.
//
// Handling a masked field is the one subtlety here: the input box **does not show** the mask itself, only a
// "saved" hint line. That leaves one rule in the UI -- text in the box means the user typed it, and
// an empty box means an empty value. Putting "__masked__:...abc123" into the box would make the user think it is placeholder text
// they have to delete, which makes clearing a credential by accident more likely rather than less.
export function ConfigField({
  def,
  value,
  isSecret,
  onChange,
}: {
  def: FieldDef;
  value: unknown;
  isSecret: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = `n-cfg-${def.key}`;
  const raw = asText(value);
  // The mask the backend echoes back: it looks like "__masked__:...abc123", ending in a recognizable fragment of the original value.
  const masked = isSecret && raw.startsWith("__masked__");
  const maskedTail = masked ? (raw.split("…")[1] ?? "") : "";

  if (def.kind === "switch") {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Switch checked={value === true} onCheckedChange={onChange} aria-label={def.label} />
        {def.label}
        {def.help && <span className="text-muted-foreground">({def.help})</span>}
      </div>
    );
  }

  if (def.kind === "select") {
    return (
      <div className="grid gap-2">
        <Label>{def.label}</Label>
        <Select value={raw || def.options?.[0]?.value} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(def.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  // The control is dispatched by field type. An if chain rather than nested ternaries, because four controls are distinguished here
  // and three levels of ternary already means stopping to count brackets.
  function control() {
    if (def.kind === "textarea" || def.kind === "kv") {
      return (
        <Textarea
          id={id}
          className="font-mono"
          placeholder={def.placeholder}
          value={masked ? "" : raw}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    if (def.kind === "list") {
      return (
        <Input
          id={id}
          value={Array.isArray(value) ? (value as string[]).join(", ") : raw}
          onChange={(e) => onChange(e.target.value)}
          placeholder={def.placeholder}
        />
      );
    }
    return (
      <Input
        id={id}
        className={def.kind === "text" ? "font-mono" : ""}
        type={inputType(def.kind)}
        placeholder={def.placeholder}
        value={masked ? "" : raw}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  const hint = masked ? (
    <p className="text-muted-foreground flex items-center gap-1 text-xs">
      <CheckIcon className="size-3" />
      Saved{maskedTail ? ` (ending in ${maskedTail})` : ""} - entering a new value overwrites it, and clearing it deletes the entry
    </p>
  ) : (
    def.help && <p className="text-muted-foreground text-xs">{def.help}</p>
  );

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{def.label}</Label>
      {control()}
      {hint}
    </div>
  );
}

// FilterSummary compresses the filter conditions into one line, so a card shows what a channel pushes without being expanded.
export function FilterSummary({ filter }: { filter: NotificationFilter }) {
  const parts: string[] = [];
  if (filter.min_severity) {
    parts.push(SEVERITY_OPTIONS.find((o) => o.value === filter.min_severity)?.label ?? filter.min_severity);
  }
  if (filter.vulnclass_include?.length) parts.push(`type matches ${filter.vulnclass_include.length} keywords`);
  if (filter.vulnclass_exclude?.length) parts.push(`excluding ${filter.vulnclass_exclude.length} keywords`);
  if (filter.task_ids?.length) parts.push(`${filter.task_ids.length} tasks`);
  if (filter.asset_ids?.length) parts.push(`${filter.asset_ids.length} assets`);
  if (filter.on_status_change) parts.push("including status changes");
  if (parts.length === 0) {
    return <p className="text-muted-foreground text-sm">Every finding</p>;
  }
  return <p className="text-muted-foreground text-sm">{parts.join(" · ")}</p>;
}
