import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor: the compose test container renders MUI/DataGrid slowly under parallel load.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => cleanup());
