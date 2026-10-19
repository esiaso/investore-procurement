import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack } from '@mui/material';
import { FormEvent, ReactNode } from 'react';

/** Dialog wrapping a <form>: Enter submits, Esc cancels. */
export function FormDialog({
  open,
  title,
  onClose,
  onSubmit,
  submitting,
  submitLabel = 'Save',
  maxWidth = 'sm',
  children,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  onSubmit(e: FormEvent): void;
  submitting?: boolean;
  submitLabel?: string;
  maxWidth?: 'xs' | 'sm' | 'md' | 'lg';
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth={maxWidth} aria-labelledby="form-dialog-title">
      <form onSubmit={onSubmit} noValidate>
        <DialogTitle id="form-dialog-title">{title}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {children}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={submitting}>
            {submitting ? 'Saving…' : submitLabel}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
