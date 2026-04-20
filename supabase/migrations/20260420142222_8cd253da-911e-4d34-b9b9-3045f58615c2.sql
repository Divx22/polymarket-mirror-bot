-- Stations table: official weather stations used for Polymarket settlement
CREATE TABLE public.stations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  city TEXT NOT NULL UNIQUE,
  station_name TEXT NOT NULL,
  station_code TEXT NOT NULL,
  latitude NUMERIC NOT NULL,
  longitude NUMERIC NOT NULL,
  timezone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stations_city_lower ON public.stations (lower(city));

ALTER TABLE public.stations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stations readable by authenticated"
  ON public.stations FOR SELECT
  TO authenticated
  USING (true);

CREATE TRIGGER update_stations_updated_at
  BEFORE UPDATE ON public.stations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed major Polymarket weather cities with their settlement stations
INSERT INTO public.stations (city, station_name, station_code, latitude, longitude, timezone) VALUES
  ('New York',       'Central Park',                  'KNYC', 40.7794, -73.9692, 'America/New_York'),
  ('Los Angeles',    'USC Downtown LA',               'KCQT', 34.0235, -118.2912,'America/Los_Angeles'),
  ('Chicago',        'Chicago Midway Airport',        'KMDW', 41.7868, -87.7522, 'America/Chicago'),
  ('Miami',          'Miami International Airport',   'KMIA', 25.7959, -80.2870, 'America/New_York'),
  ('Houston',        'Houston Bush Intercontinental', 'KIAH', 29.9844, -95.3414, 'America/Chicago'),
  ('Dallas',         'Dallas/Fort Worth Airport',     'KDFW', 32.8998, -97.0403, 'America/Chicago'),
  ('Phoenix',        'Phoenix Sky Harbor Airport',    'KPHX', 33.4342, -112.0116,'America/Phoenix'),
  ('Philadelphia',   'Philadelphia Intl Airport',     'KPHL', 39.8729, -75.2437, 'America/New_York'),
  ('Boston',         'Boston Logan Airport',          'KBOS', 42.3656, -71.0096, 'America/New_York'),
  ('Atlanta',        'Hartsfield-Jackson Atlanta',    'KATL', 33.6407, -84.4277, 'America/New_York'),
  ('Denver',         'Denver International Airport',  'KDEN', 39.8561, -104.6737,'America/Denver'),
  ('Seattle',        'Seattle-Tacoma Airport',        'KSEA', 47.4502, -122.3088,'America/Los_Angeles'),
  ('San Francisco',  'San Francisco Intl Airport',    'KSFO', 37.6213, -122.3790,'America/Los_Angeles'),
  ('Austin',         'Austin-Bergstrom Airport',      'KAUS', 30.1945, -97.6699, 'America/Chicago'),
  ('Minneapolis',    'Minneapolis-St Paul Airport',   'KMSP', 44.8848, -93.2223, 'America/Chicago'),
  ('Washington DC',  'Reagan National Airport',       'KDCA', 38.8521, -77.0377, 'America/New_York'),
  ('Toronto',        'Toronto Pearson Airport',       'CYYZ', 43.6777, -79.6248, 'America/Toronto'),
  ('London',         'London Heathrow Airport',       'EGLL', 51.4700, -0.4543,  'Europe/London'),
  ('Paris',          'Paris Charles de Gaulle',       'LFPG', 49.0097,  2.5479,  'Europe/Paris'),
  ('Berlin',         'Berlin Brandenburg Airport',    'EDDB', 52.3667, 13.5033,  'Europe/Berlin'),
  ('Madrid',         'Madrid Barajas Airport',        'LEMD', 40.4983, -3.5676,  'Europe/Madrid'),
  ('Rome',           'Rome Fiumicino Airport',        'LIRF', 41.8003, 12.2389,  'Europe/Rome'),
  ('Moscow',         'Moscow Sheremetyevo Airport',   'UUEE', 55.9726, 37.4146,  'Europe/Moscow'),
  ('Istanbul',       'Istanbul Airport',              'LTFM', 41.2753, 28.7519,  'Europe/Istanbul'),
  ('Tokyo',          'Tokyo Haneda Airport',          'RJTT', 35.5494, 139.7798, 'Asia/Tokyo'),
  ('Seoul',          'Incheon International Airport', 'RKSI', 37.4602, 126.4407, 'Asia/Seoul'),
  ('Beijing',        'Beijing Capital Airport',       'ZBAA', 40.0801, 116.5846, 'Asia/Shanghai'),
  ('Shanghai',       'Shanghai Pudong Airport',       'ZSPD', 31.1443, 121.8083, 'Asia/Shanghai'),
  ('Hong Kong',      'Hong Kong International',       'VHHH', 22.3080, 113.9185, 'Asia/Hong_Kong'),
  ('Singapore',      'Singapore Changi Airport',      'WSSS',  1.3644, 103.9915, 'Asia/Singapore'),
  ('Dubai',          'Dubai International Airport',   'OMDB', 25.2532,  55.3657, 'Asia/Dubai'),
  ('Mumbai',         'Mumbai Chhatrapati Shivaji',    'VABB', 19.0896,  72.8656, 'Asia/Kolkata'),
  ('Delhi',          'Delhi Indira Gandhi Airport',   'VIDP', 28.5562,  77.1000, 'Asia/Kolkata'),
  ('Sydney',         'Sydney Kingsford Smith Airport','YSSY', -33.9399, 151.1753,'Australia/Sydney'),
  ('Mexico City',    'Mexico City Intl Airport',      'MMMX', 19.4361, -99.0719, 'America/Mexico_City'),
  ('Sao Paulo',      'Sao Paulo Guarulhos Airport',   'SBGR', -23.4356, -46.4731,'America/Sao_Paulo'),
  ('Rio de Janeiro', 'Rio Galeao Airport',            'SBGL', -22.8090, -43.2506,'America/Sao_Paulo'),
  ('Buenos Aires',   'Ministro Pistarini Airport',    'SAEZ', -34.8222, -58.5358,'America/Argentina/Buenos_Aires');