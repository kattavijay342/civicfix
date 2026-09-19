export interface ImageCredit {
  file: string;
  title: string;
  author: string;
  license: string;
  source: string;
}

/**
 * Every photograph in /public/images is a real, freely-licensed civic photo
 * sourced from Wikimedia Commons. Attribution is required by the CC BY /
 * CC BY-SA licenses these were published under — see the /credits page.
 */
export const imageCredits: ImageCredit[] = [
  {
    file: "hero-pothole.jpg",
    title: "Newport Carisbrooke Road pothole 2",
    author: "Editor5807",
    license: "CC BY 3.0",
    source: "https://commons.wikimedia.org/wiki/File:Newport_Carisbrooke_Road_pothole_2.JPG",
  },
  {
    file: "ai-analysis-pothole.jpg",
    title: "Bielsko-Biała, ulica Widok - uszkodzona dziurawa droga 02",
    author: "Kamil Czaiński",
    license: "CC BY-SA 4.0",
    source:
      "https://commons.wikimedia.org/wiki/File:Bielsko-Bia%C5%82a,_ulica_Widok_-_uszkodzona_dziurawa_droga_02.jpg",
  },
  {
    file: "issue-pothole.jpg",
    title: "Windsor Road Potholes",
    author: "Alan Stanton",
    license: "CC BY-SA 2.0",
    source: "https://commons.wikimedia.org/wiki/File:Windsor_Road_Potholes.jpg",
  },
  {
    file: "issue-garbage.jpg",
    title: "Overflowing Hamburg street garbage bin",
    author: "Unknown",
    license: "Public domain",
    source: "https://commons.wikimedia.org/wiki/File:Overflowing_Hamburg_street_garbage_bin.jpg",
  },
  {
    file: "issue-drainage.jpg",
    title: "Torrential rain lash Kolkata, many areas waterlogged",
    author: "Sumita Roy Dutta",
    license: "CC BY-SA 4.0",
    source:
      "https://commons.wikimedia.org/wiki/File:Torrential_rain_lash_Kolkata,_many_areas_waterlogged-_Kolkata-West_Bengal-September_2021-IMG_20210915_205028.jpg",
  },
  {
    file: "issue-streetlight.jpg",
    title: "Broken lamppost - streetlight on A899 Livingston Road",
    author: "Simon Johnston",
    license: "CC BY-SA 2.0",
    source:
      "https://commons.wikimedia.org/wiki/File:Broken_lamppost_-_streetlight_on_A899_Livingston_Road_-_geograph.org.uk_-_957464.jpg",
  },
  {
    file: "issue-water-leak.jpg",
    title: "Flow from leaking water pipe in Churchland Lane, Sedlescombe",
    author: "Patrick Roper",
    license: "CC BY-SA 2.0",
    source:
      "https://commons.wikimedia.org/wiki/File:Flow_from_leaking_water_pipe_in_Churchland_Lane,_Sedlescombe_-_geograph.org.uk_-_7250470.jpg",
  },
  {
    file: "issue-dumping.jpg",
    title: "Ferndale Road N15 - Dumped Rubbish",
    author: "Alan Stanton",
    license: "CC BY-SA 2.0",
    source:
      "https://commons.wikimedia.org/wiki/File:Ferndale_Road_N15_-_Dumped_Rubbish_(16246615431).jpg",
  },
  {
    file: "issue-infrastructure.jpg",
    title: "An urban road and traffic in Bangalore Karnataka India",
    author: "Harsha K R",
    license: "CC BY-SA 2.0",
    source:
      "https://commons.wikimedia.org/wiki/File:An_urban_road_and_traffic_in_Bangalore_Karnataka_India_April_2014.jpg",
  },
  {
    file: "before-pothole.jpg",
    title: "Newport Carisbrooke Road pothole 3",
    author: "Editor5807",
    license: "CC BY 3.0",
    source: "https://commons.wikimedia.org/wiki/File:Newport_Carisbrooke_Road_pothole_3.JPG",
  },
  {
    file: "after-road-repair.jpg",
    title: "Construction equipment and workers repairing a road in Texas",
    author: "Patsy Lynch / FEMA",
    license: "Public domain",
    source:
      "https://commons.wikimedia.org/wiki/File:FEMA_-_44130_-_Construction_equipment_and_workers_repairing_a_road_in_Texas.jpg",
  },
  {
    file: "city-bg.jpg",
    title: "Nehru Outer Ringroad near Narasinghi",
    author: "iMahesh",
    license: "CC BY-SA 4.0",
    source: "https://commons.wikimedia.org/wiki/File:Nehru_Outer_Ringroad_near_Narasinghi_(2).jpg",
  },
  {
    file: "issue-sewage.jpg",
    title: "Sewage works",
    author: "Evelyn Simak",
    license: "CC BY-SA 2.0",
    source: "https://commons.wikimedia.org/wiki/File:Sewage_works_-_geograph.org.uk_-_1121093.jpg",
  },
];
