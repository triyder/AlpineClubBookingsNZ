export interface ClubIdentity {
  name: string;
  shortName: string;
  supportEmail: string;
  contactEmail: string;
  publicUrl: string;
  emailFromName: string;
  lodgeTravelNote: string;
  hutLeaderLabel: string;
  socialLinks: {
    facebook?: string;
  };
  bookingsName: string;
  lodgeName: string;
  publicHost: string;
  lodgeCapacity: number;
}
