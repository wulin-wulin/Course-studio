type ImageAttachmentsProps = {
  images: string[];
  className?: string;
};

export function ImageAttachments({ images, className = "" }: ImageAttachmentsProps) {
  if (!images.length) return null;

  return (
    <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 ${className}`}>
      {images.map((image, index) => (
        <div
          key={`${image.slice(0, 24)}-${index}`}
          className="overflow-hidden rounded-md border border-border bg-surface aspect-square"
        >
          <img
            src={resolveImageSrc(image)}
            alt={`图片 ${index + 1}`}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        </div>
      ))}
    </div>
  );
}

function resolveImageSrc(image: string) {
  return image.startsWith("data:") ? image : `data:image/png;base64,${image}`;
}
