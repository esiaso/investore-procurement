import NotificationsIcon from '@mui/icons-material/Notifications';
import { Badge, Box, Button, Divider, IconButton, ListItemText, Menu, MenuItem, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

interface NotificationList {
  unread: number;
  items: { id: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }[];
}

/** In-app notifications (approvals waiting, decisions made, inspections needed). Polls every 30 s. */
export function NotificationBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { data } = useQuery({ queryKey: ['/notifications'], queryFn: () => api<NotificationList>('/notifications'), refetchInterval: 30_000 });
  const markRead = async (ids?: string[]) => {
    await api('/notifications/read', { method: 'POST', body: { ids } });
    await qc.invalidateQueries({ queryKey: ['/notifications'] });
  };

  return (
    <>
      <IconButton color="inherit" aria-label={`Notifications (${data?.unread ?? 0} unread)`} onClick={(e) => setAnchor(e.currentTarget)}>
        <Badge badgeContent={data?.unread ?? 0} color="error" max={99}>
          <NotificationsIcon />
        </Badge>
      </IconButton>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { width: 360, maxHeight: 480 } } }}>
        <Box sx={{ px: 2, py: 1, display: 'flex', alignItems: 'center' }}>
          <Typography fontWeight={600} sx={{ flexGrow: 1 }}>
            Notifications
          </Typography>
          {!!data?.unread && <Button size="small" onClick={() => markRead()}>Mark all read</Button>}
        </Box>
        <Divider />
        {(data?.items ?? []).length === 0 && <MenuItem disabled>Nothing yet</MenuItem>}
        {(data?.items ?? []).map((n) => (
          <MenuItem
            key={n.id}
            onClick={async () => {
              setAnchor(null);
              if (!n.readAt) await markRead([n.id]);
              if (n.link) navigate(n.link);
            }}
            sx={{ whiteSpace: 'normal', fontWeight: n.readAt ? 400 : 600 }}
          >
            <ListItemText primary={n.title} secondary={n.body} primaryTypographyProps={{ fontWeight: n.readAt ? 400 : 600 }} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
