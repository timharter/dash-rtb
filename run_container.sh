docker run -it --rm \
    -p 5173:5173 \
    -v ./app:/app \
    --name sam_test \
    sam_test /bin/sh 