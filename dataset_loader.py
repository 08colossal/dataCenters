import os
import pandas as pd
import kagglehub

print("Baixando dataset do Kaggle...")
path = kagglehub.dataset_download("rockyt0/world-data-centers")

# Procura por todos os arquivos CSV na pasta baixada
csv_files = []
for root, dirs, files in os.walk(path):
    for file in files:
        if file.endswith(".csv"):
            csv_files.append(os.path.join(root, file))

if not csv_files:
    raise FileNotFoundError("Nenhum arquivo CSV encontrado no dataset baixado.")

# Identifica qual arquivo CSV contém as coordenadas de latitude/longitude
target_df = None
lat_col, lon_col = None, None

for file_path in csv_files:
    temp_df = pd.read_csv(file_path)
    l_col = next((c for c in temp_df.columns if c.lower() in ("latitude", "lat")), None)
    o_col = next((c for c in temp_df.columns if c.lower() in ("longitude", "lon", "lng")), None)

    if l_col and o_col:
        target_df = temp_df
        lat_col = l_col
        lon_col = o_col
        print(f"Arquivo de coordenadas localizado: {os.path.basename(file_path)}")
        break

if target_df is None:
    for file_path in csv_files:
        temp_df = pd.read_csv(file_path)
        print(f"Arquivo {os.path.basename(file_path)} colunas: {list(temp_df.columns)}")
    raise ValueError("Não foi encontrado nenhum arquivo CSV no dataset contendo colunas de latitude e longitude.")

# Colunas enriquecidas exportadas para o site
out_cols = [
    "name", "operator", "facility_kind", "city", "street", "postcode",
    "state", "country", "country_iso2", "lat", "lon",
    "footprint_area_m2", "website", "osm_url",
]
# Mapeia nomes reais do dataset para nomes de saída
rename = {lat_col: "lat", lon_col: "lon"}
df = target_df.rename(columns=rename)
# Mantém só colunas disponíveis + preenche ausentes com vazio
for col in out_cols:
    if col not in df.columns:
        df[col] = ""
df = df.dropna(subset=["lat", "lon"])
df["name"] = df["name"].fillna("").astype(str).str.strip()
# Fallback: sem nome → operator → índice
missing = df["name"].eq("") | df["name"].str.lower().isin(["nan", "none"])
df.loc[missing, "name"] = df.loc[missing, "operator"].fillna("").astype(str).str.strip()
still_missing = df["name"].eq("") | df["name"].str.lower().isin(["nan", "none"])
df.loc[still_missing, "name"] = ["DC-%04d" % i for i in range(still_missing.sum())]

df[out_cols].to_csv("world_data_centers.csv", index=False, encoding="utf-8")
print(f"Sucesso! {len(df)} data centers exportados para world_data_centers.csv")
