"use client";

import { FolderOpen } from "lucide-react";
import Image from "next/image";
import { useId } from "react";

import { ALBUM_COVERS } from "@/lib/album-covers";

import styles from "./AlbumCoverPicker.module.css";

type AlbumCoverPickerProps = {
  defaultValue?: string | null;
  value?: string | null;
  onChange?: (value: string | null) => void;
  includeAutomatic?: boolean;
  disabled?: boolean;
};

export function AlbumCoverPicker({
  defaultValue,
  value,
  onChange,
  includeAutomatic = false,
  disabled = false,
}: AlbumCoverPickerProps) {
  const hintId = useId();
  const controlled = value !== undefined;
  const selectedValue = controlled
    ? value ?? ""
    : defaultValue ?? (includeAutomatic ? "" : ALBUM_COVERS[0].src);

  return (
    <fieldset
      className={styles.fieldset}
      aria-describedby={hintId}
      disabled={disabled}
    >
      <legend>앨범 커버</legend>
      <p id={hintId}>
        {includeAutomatic
          ? "자동 커버를 유지하거나 기타 사진을 선택하세요."
          : "앨범 폴더에 사용할 기타 사진을 선택하세요."}
      </p>
      <div className={styles.options}>
        {includeAutomatic ? (
          <div className={styles.option}>
            <input
              id={`${hintId}-automatic`}
              name="coverAsset"
              type="radio"
              value=""
              checked={controlled ? selectedValue === "" : undefined}
              defaultChecked={!controlled ? selectedValue === "" : undefined}
              onChange={() => onChange?.(null)}
            />
            <label htmlFor={`${hintId}-automatic`}>
              <span className={`${styles.preview} ${styles.automatic}`}>
                <FolderOpen size={24} aria-hidden="true" />
              </span>
              <span>자동 선택</span>
            </label>
          </div>
        ) : null}
        {ALBUM_COVERS.map((cover, index) => {
          const id = `${hintId}-cover-${index}`;
          return (
            <div className={styles.option} key={cover.src}>
              <input
                id={id}
                name="coverAsset"
                type="radio"
                value={cover.src}
                checked={controlled ? selectedValue === cover.src : undefined}
                defaultChecked={!controlled ? selectedValue === cover.src : undefined}
                onChange={() => onChange?.(cover.src)}
              />
              <label htmlFor={id}>
                <span className={styles.preview}>
                  <Image
                    src={cover.src}
                    alt=""
                    fill
                    sizes="(max-width: 340px) 42vw, (max-width: 560px) 29vw, 124px"
                  />
                </span>
                <span>{cover.label}</span>
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
