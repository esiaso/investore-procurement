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
  },
});
