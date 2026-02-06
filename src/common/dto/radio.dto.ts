export type RadioStationDto = {
  id: string;
  name: string;
  streamUrl: string;
  attributionName: string | null;
  attributionUrl: string | null;
};

export type RadioListenerDto = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  paused?: boolean;
};

