import type { UserListDto } from '../../common/dto/user.dto';

export type LocationBrowseSectionDto = {
  key: 'sameZip' | 'sameCity' | 'sameCounty' | 'sameState';
  label: string;
  users: UserListDto[];
};

export type LocationBrowseResponseDto = {
  location: {
    zip?: string;
    city?: string;
    county?: string;
    state: string;
    stateDisplay: string;
  };
  memberCount: number;
  sections: LocationBrowseSectionDto[];
};
