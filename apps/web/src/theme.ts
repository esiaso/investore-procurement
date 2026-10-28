import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    primary: { main: '#0b6e6e' },
    secondary: { main: '#5b4b8a' },
    background: { default: '#f5f7f8' },
  },
  shape: { borderRadius: 8 },
  typography: { fontSize: 14, h5: { fontWeight: 600 }, h6: { fontWeight: 600 } },
  components: {
    MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
    MuiFormControl: { defaultProps: { size: 'small', fullWidth: true } },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiDialog: { defaultProps: { fullWidth: true, maxWidth: 'sm' } },
    // Side panels (item details, bin card…) open below the fixed app bar, which sits above
    // drawers (AppLayout), so their header is never hidden. Heights match the Toolbar's.
    MuiDrawer: {
      styleOverrides: {
        paperAnchorRight: ({ theme }) => ({
          top: 56,
          height: 'calc(100% - 56px)',
          [`${theme.breakpoints.up('xs')} and (orientation: landscape)`]: { top: 48, height: 'calc(100% - 48px)' },
          [theme.breakpoints.up('sm')]: { top: 64, height: 'calc(100% - 64px)' },
        }),
      },
    },
  },
});
