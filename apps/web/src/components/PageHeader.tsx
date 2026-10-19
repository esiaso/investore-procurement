import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import { Box, Button, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import { ReactNode, useEffect, useRef } from 'react';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/**
 * Title row with optional search and "New" button.
 * Shortcuts: "/" focuses search, Alt+N opens the New dialog.
 */
export function PageHeader({
  title,
  search,
  onSearch,
  searchPlaceholder = 'Search',
  onNew,
  newLabel = 'New',
  actions,
}: {
  title: string;
  search?: string;
  onSearch?(value: string): void;
  searchPlaceholder?: string;
  onNew?(): void;
  newLabel?: string;
  actions?: ReactNode;
}) {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !isTyping(e.target) && searchRef.current) {
        e.preventDefault();
        searchRef.current.focus();
      } else if (e.altKey && (e.key === 'n' || e.key === 'N') && onNew) {
        e.preventDefault();
        onNew();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNew]);

  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.5}
      alignItems={{ xs: 'stretch', sm: 'center' }}
      sx={{ mb: 2 }}
    >
      <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>
        {title}
      </Typography>
      {onSearch && (
        <Box sx={{ width: { xs: '100%', sm: 320 } }}>
          <TextField
            inputRef={searchRef}
            value={search ?? ''}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={`${searchPlaceholder}  ( / )`}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
              htmlInput: { 'aria-label': searchPlaceholder },
            }}
          />
        </Box>
      )}
      {actions}
      {onNew && (
        <Button variant="contained" startIcon={<AddIcon />} onClick={onNew} title="Alt+N">
          {newLabel}
        </Button>
      )}
    </Stack>
  );
}
