"use client";

import * as React from "react";

import { RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { FindingRetest } from "@/lib/types";

interface FindingRetestDialogProps {
  findingId: string;
  findingName?: string;
  onClose: () => void;
  onStarted?: (retest: FindingRetest) => void;
}

// It is mounted only while open and the notes are cleared on close; the list and the detail share the submit lock and the error handling, and starting one leaves you on the current page.
export function FindingRetestDialog({ findingId, findingName, onClose, onStarted }: FindingRetestDialogProps) {
  const notesId = React.useId();
  const [notes, setNotes] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const submitLock = React.useRef(false);

  async function start() {
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      const result = await api.startFindingRetest(findingId, notes.trim());
      onStarted?.(result.retest);
      onClose();
      toast.success(result.created ? "The retest has started; click \"Retesting\" to see the conversation" : "This finding is already being retested; the existing conversation can be opened");
    } catch (e) {
      toast.error(`Starting the retest failed: ${(e as Error).message}`);
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !submitLock.current && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retest finding #{findingId}</DialogTitle>
          <DialogDescription className="break-words">
            {findingName ? <span className="mb-2 block">{findingName}</span> : null}
            The retest agent
            reads the original evidence and the test constraints and runs a targeted verification in its own conversation. When a retest completes successfully and confirms the fix, the finding's status changes to "Fixed" automatically; any other conclusion leaves the status as it was.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-disabled={submitting}>
            <FieldLabel htmlFor={notesId}>Additional notes (optional)</FieldLabel>
            <Textarea
              id={notesId}
              value={notes}
              maxLength={4000}
              rows={4}
              disabled={submitting}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="For example: verify the original endpoint with the original test account; the fix is in v2."
            />
            <FieldDescription>Useful for the fixed version, the test conditions or this run's limitations.</FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={submitting} onClick={() => void start()}>
            {submitting ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}
            {submitting ? "Creating..." : "Start the retest"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
