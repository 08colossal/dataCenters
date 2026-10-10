import os
import json
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
lat_col, lon_col, name_col = None, None, None

for file_path in csv_files:
    temp_df = pd.read_csv(file_path)
    l_col = next((c for c in temp_df.columns if any(k in c.lower() for k in ['lat'])), None)
    o_col = next((c for c in temp_df.columns if any(k in c.lower() for k in ['lon', 'lng'])), None)
    
    if l_col and o_col:
        target_df = temp_df
        lat_col = l_col
        lon_col = o_col
        name_col = next((c for c in target_df.columns if any(k in c.lower() for k in ['name', 'title', 'tag', 'datacenter', 'center'])), target_df.columns[0])
        print(f"Arquivo de coordenadas localizado: {os.path.basename(file_path)}")
        break

if target_df is None:
    # Se nenhum arquivo tiver lat/lon direta, exibe todos para diagnóstico
    for file_path in csv_files:
        temp_df = pd.read_csv(file_path)
        print(f"Arquivo {os.path.basename(file_path)} colunas: {list(temp_df.columns)}")
    raise ValueError("Não foi encontrado nenhum arquivo CSV no dataset contendo colunas de latitude e longitude.")

print(f"Mapeamento selecionado -> Nome: '{name_col}', Lat: '{lat_col}', Lon: '{lon_col}'")

# Limpa valores nulos e converte para dicionário
target_df = target_df.dropna(subset=[lat_col, lon_col])
data_centers = []
for idx, row in target_df.iterrows():
    data_centers.append({
        "name": str(row[name_col]),
        "lat": float(row[lat_col]),
        "lon": float(row[lon_col])
    })

json_data = json.dumps(data_centers, ensure_ascii=False)

# Injeta os dados diretamente no index.html
html_path = "index.html"
if os.path.exists(html_path):
    with open(html_path, "r", encoding="utf-8") as f:
        html_content = f.read()
    
    marker_start = "/*__INJECT_DATA_START__*/"
    marker_end = "/*__INJECT_DATA_END__*/"
    
    injected_code = f"{marker_start}\n  var EMBEDDED_DATA_CENTERS = {json_data};\n  {marker_end}"
    
    if marker_start in html_content:
        import re
        html_content = re.sub(r'/\*__INJECT_DATA_START__\*/.*?(/\*__INJECT_DATA_END__\*/)', injected_code, html_content, flags=re.DOTALL)
    else:
        html_content = html_content.replace("var CONFIG =", f"{injected_code}\n  var CONFIG =")

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)
    print(f"Sucesso! {len(data_centers)} data centers mapeados e injetados no index.html.")
else:
    print("Erro: O arquivo index.html não foi encontrado na pasta atual.")