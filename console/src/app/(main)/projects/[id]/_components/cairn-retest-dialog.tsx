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
import { cairn, type Retest } from "@/lib/cairn-api";

export function CairnRetestDialog({
  projectId,
  findingId,
  findingName,
  onClose,
  onStarted,
}: {
  projectId: string;
  findingId: string;
  findingName?: string;
  onClose: () => void;
  onStarted?: (retest: Retest) => void;
}) {
  const notesId = React.useId();
  const [notes, setNotes] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const submitLock = React.useRef(false);

  async function start() {
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      const retest = await cairn.createRetest(projectId, findingId, { notes: notes.trim() });
      onStarted?.(retest);
      onClose();
      toast.success("The retest has started");
    } catch (error) {
      toast.error(`Starting the retest failed: ${(error as Error).message}`);
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
            The retest agent reads the original evidence and the test constraints and runs a targeted
            verification in its own conversation. When a retest completes successfully and confirms the fix,
            the finding's status changes to "Fixed" automatically; any other conclusion leaves the status as
            it was.
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
              onChange={(event) => setNotes(event.target.value)}
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
